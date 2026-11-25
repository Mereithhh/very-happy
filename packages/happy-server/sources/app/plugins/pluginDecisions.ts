import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
    AttentionItemLinkSchema, PLUGIN_DECISION_ATTENTION_KIND, PLUGIN_LIMITS, parsePluginPayload,
    type AttentionPluginPayload, type PluginDecisionDelete, type PluginDecisionPatch, type PluginDecisionPost, type PluginManifest,
} from '@slopus/happy-wire';
import { db } from '@/storage/db';
import { afterTx, type Tx } from '@/storage/inTx';
import { itemView, type AttentionRow } from '@/app/attention/rules';
import { audit, enqueueEvent, loadInstall, requireSessionOnMachine, runPluginTx } from './pluginStore';
import { createWindowLimiter, hasGrant, installBlock, PluginError, requirePlugin, type InstallRow } from './pluginRules';
import { emitPluginAttentionItem } from './pluginSocket';
import { pushPluginItemOnce } from './pluginPush';

/**
 * B-974 §5.3 plugin decisions, stored as AttentionItem rows with `sessionId` NULL and `pluginInstallId`
 * set, deduped on `(pluginInstallId, key)` (r4). A linked session goes in `links` (`{ type: 'session', ref }`),
 * never in `sessionId`: the row must not collide with that session's own cards or close with its archive.
 *
 * kind: choice → `decision`, input → `input`, notice → `report`. The card's plugin fields are the wire
 * `AttentionPluginPayload` in `payload` (r5); `pluginState` holds what only the server needs
 * (`push`, the plugin's acknowledgement time).
 */

const createLimiter = createWindowLimiter(PLUGIN_LIMITS.decisionCreatesPerMinute, 60_000);
const ACTIVE = ['open', 'in_progress'];
export const REVIEW_KEY = 'vh:install-review';

interface Internal { push: boolean; ackedAt?: number }

function internalOf(row: { pluginState?: unknown }): Internal {
    return { push: true, ...((row.pluginState as Partial<Internal> | null) ?? {}) };
}

function payloadOf(row: { payload: unknown }): AttentionPluginPayload {
    const p = parsePluginPayload(row.payload);
    if (!p) throw new PluginError('not_found', 404);
    return p as AttentionPluginPayload;
}

// Prisma types `payload` as the wrap-up shape (prisma-json-types); a plugin card stores the wire plugin payload there.
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as never;

function basePayload(install: InstallRow, input: { kind: AttentionPluginPayload['decisionKind']; options?: Array<{ id: string; style?: string }>; input?: AttentionPluginPayload['input']; panelPath?: string | null }): AttentionPluginPayload {
    const manifest = install.manifest as PluginManifest | null;
    const styles = Object.fromEntries((input.options ?? []).filter(o => o.style).map(o => [o.id, o.style!])) as AttentionPluginPayload['optionStyles'];
    return {
        v: 1, type: 'plugin', pluginId: install.pluginId, pluginName: manifest?.name ?? install.pluginId,
        ...(manifest?.icon ? { pluginIcon: manifest.icon } : {}),
        machineId: install.machineId, decisionKind: input.kind,
        ...(styles && Object.keys(styles).length ? { optionStyles: styles } : {}),
        ...(input.input ? { input: input.input } : {}),
        ...(input.panelPath ? { panelPath: input.panelPath } : {}),
        pluginState: 'open', delivery: 'pending',
    };
}

/** `PluginDecision` (§5.3) as the plugin sees it. */
export function decisionView(row: AttentionRow) {
    const p = payloadOf(row);
    return {
        itemId: row.id, key: row.key!, kind: p.decisionKind, title: row.title, bodyMd: row.bodyMd,
        options: Array.isArray(row.options) ? (row.options as Array<{ id: string; label: string; detail?: string }>).map(o => ({ ...o, ...(p.optionStyles?.[o.id] ? { style: p.optionStyles[o.id] } : {}) })) : null,
        input: p.input ?? null,
        sessionId: linkedSession(row.links),
        panelPath: p.panelPath ?? null,
        state: p.pluginState,
        response: p.response ?? null,
        delivery: p.delivery ?? 'pending',
        version: row.version, createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime(),
    };
}

/** r5: plugin card links are `AttentionItemLink`s (`session` included), never the agents' `AttentionLink`. */
export function linkedSession(links: unknown): string | null {
    if (!Array.isArray(links)) return null;
    for (const raw of links) {
        const link = AttentionItemLinkSchema.safeParse(raw);
        if (link.success && link.data.type === 'session') return link.data.ref;
    }
    return null;
}

function announce(tx: Tx, row: AttentionRow, push: boolean) {
    afterTx(tx, () => {
        emitPluginAttentionItem(row.accountId, itemView(row));
        if (push && row.pluginInstallId) void pushPluginItemOnce({ id: row.id, accountId: row.accountId, title: row.title, state: row.state, pluginInstallId: row.pluginInstallId });
    });
}

function requireKey(key: string) {
    // `vh:` keys are the host's own cards about this install (the review card).
    requirePlugin(!key.startsWith('vh:'), 'invalid_request', 400, { issues: [{ path: ['key'], message: 'keys starting with "vh:" are reserved' }] });
}

/** Grants a decision write needs beyond `decisions` (also checked up front by the op handler), and the session must be on this machine. */
async function checkRefs(install: InstallRow, input: { sessionId?: string; panelPath?: string | null }) {
    if (input.sessionId) {
        requirePlugin(hasGrant(install, 'session.widget') || hasGrant(install, 'sessions.list'), 'permission_denied', 403, { permission: 'session.widget' });
        await requireSessionOnMachine(install.accountId, install.machineId, input.sessionId);
    }
    if (input.panelPath) requirePlugin(hasGrant(install, 'panel'), 'permission_denied', 403, { permission: 'panel' });
}

async function enforceActive(tx: Tx, install: InstallRow) {
    const active = await tx.attentionItem.count({ where: { pluginInstallId: install.id, state: { in: ACTIVE }, NOT: { key: { startsWith: 'vh:' } } } });
    requirePlugin(active < PLUGIN_LIMITS.activeDecisionsPerInstall, 'limit_exceeded', 422, { limit: PLUGIN_LIMITS.activeDecisionsPerInstall });
}

const reopenRow = { state: 'open', resolvedBy: null, resolvedAt: null, ownerChoice: null, ownerNote: null, resolveNote: null };
const stripStyle = (options: Array<{ id: string; label: string; style?: string; detail?: string }>) => options.map(({ style: _style, ...o }) => o);

export async function postDecision(install: InstallRow, input: PluginDecisionPost, requestId?: string) {
    requireKey(input.key);
    await checkRefs(install, input);
    return runPluginTx(async tx => {
        const existing = await tx.attentionItem.findUnique({ where: { pluginInstallId_key: { pluginInstallId: install.id, key: input.key } } }) as AttentionRow | null;
        if (existing && requestId && existing.lastRequestId === requestId) return { item: decisionView(existing), created: false };
        if (existing) requirePlugin(payloadOf(existing).decisionKind === input.kind, 'version_conflict', 409, { currentVersion: existing.version });
        const now = new Date();
        const payload = basePayload(install, { kind: input.kind, options: input.options, input: input.input, panelPath: input.panelPath });
        const content = {
            title: input.title, bodyMd: input.bodyMd ?? null,
            options: (input.options ? stripStyle(input.options) : Prisma.DbNull) as never,
            links: (input.sessionId ? [AttentionItemLinkSchema.parse({ type: 'session', ref: input.sessionId })] : Prisma.DbNull) as never,
            lastRequestId: requestId ?? null,
        };
        let row: AttentionRow;
        if (existing) {
            // A repost updates; a responded or closed one reopens (§5.3). `pushedAt` is never cleared: one push per key.
            const prev = payloadOf(existing);
            const reopen = !ACTIVE.includes(existing.state) || prev.pluginState !== 'open';
            if (reopen) await enforceActive(tx, install);
            row = await tx.attentionItem.update({
                where: { id: existing.id },
                data: {
                    ...content,
                    payload: json(reopen ? payload : { ...payload, delivery: prev.delivery }),
                    pluginState: { push: input.push },
                    ...(reopen ? reopenRow : {}),
                    repostCount: { increment: 1 }, version: { increment: 1 }, updatedAt: now,
                },
            }) as AttentionRow;
        } else {
            const limited = createLimiter.take(install.id);
            if (!limited.ok) throw new PluginError('rate_limited', 429, { retryAfterMs: limited.retryAfterMs });
            await enforceActive(tx, install);
            row = await tx.attentionItem.create({
                data: {
                    ...content, payload: json(payload), id: randomUUID(), accountId: install.accountId, sessionId: null, pluginInstallId: install.id,
                    source: 'plugin', kind: PLUGIN_DECISION_ATTENTION_KIND[input.kind], key: input.key, needsOwner: true, state: 'open',
                    pluginState: { push: input.push }, createdAt: now, updatedAt: now,
                },
            }) as AttentionRow;
        }
        announce(tx, row, input.push);
        return { item: decisionView(row), created: !existing };
    });
}

async function loadByKey(tx: Tx, install: InstallRow, key: string): Promise<AttentionRow> {
    requireKey(key);
    const row = await tx.attentionItem.findUnique({ where: { pluginInstallId_key: { pluginInstallId: install.id, key } } });
    requirePlugin(row, 'not_found', 404);
    return row as AttentionRow;
}

export async function patchDecision(install: InstallRow, input: PluginDecisionPatch & { key: string }, requestId?: string) {
    if (input.panelPath) await checkRefs(install, { panelPath: input.panelPath });
    return runPluginTx(async tx => {
        const row = await loadByKey(tx, install, input.key);
        if (requestId && row.lastRequestId === requestId) return { item: decisionView(row) };
        if (input.expectedVersion !== undefined) requirePlugin(row.version === input.expectedVersion, 'version_conflict', 409, { currentVersion: row.version });
        const p = payloadOf(row);
        if (input.options) requirePlugin(p.decisionKind === 'choice', 'invalid_request', 400, { issues: [{ path: ['options'], message: 'options are only for choice' }] });
        if (input.input) requirePlugin(p.decisionKind === 'input', 'invalid_request', 400, { issues: [{ path: ['input'], message: 'input spec is only for input' }] });
        const reopen = input.reopen === true && p.pluginState !== 'open';
        if (reopen) await enforceActive(tx, install);
        const styles = input.options ? Object.fromEntries(input.options.filter(o => o.style).map(o => [o.id, o.style!])) : undefined;
        const next: Record<string, unknown> = {
            ...p,
            ...(styles ? { optionStyles: styles } : {}),
            ...(input.input ? { input: input.input } : {}),
            ...(input.panelPath !== undefined ? { panelPath: input.panelPath ?? undefined } : {}),
            ...(reopen ? { pluginState: 'open', delivery: 'pending', response: undefined } : {}),
        };
        const updated = await tx.attentionItem.update({
            where: { id: row.id },
            data: {
                ...(input.title !== undefined ? { title: input.title } : {}),
                ...(input.bodyMd !== undefined ? { bodyMd: input.bodyMd } : {}),
                ...(input.options !== undefined ? { options: stripStyle(input.options) as never } : {}),
                payload: json(next),
                // Any PATCH after a response is the plugin's acknowledgement.
                pluginState: { ...internalOf(row), ackedAt: Date.now() },
                ...(reopen ? reopenRow : {}),
                ...(requestId ? { lastRequestId: requestId } : {}),
                version: { increment: 1 }, updatedAt: new Date(),
            },
        }) as AttentionRow;
        announce(tx, updated, false);
        return { item: decisionView(updated) };
    });
}

/** Plugin-side close (also its acknowledgement of a response). Closing twice is a no-op. */
export async function deleteDecision(install: InstallRow, input: PluginDecisionDelete & { key: string }) {
    return runPluginTx(async tx => {
        const row = await loadByKey(tx, install, input.key);
        const p = payloadOf(row);
        if (p.pluginState === 'closed') return { item: decisionView(row) };
        const now = new Date();
        const responded = p.pluginState === 'responded';
        const updated = await tx.attentionItem.update({
            where: { id: row.id },
            data: {
                // A responded card keeps the owner's answer on the row; the plugin only records it took it.
                ...(responded ? {} : { state: input.outcome === 'dropped' || input.outcome === 'superseded' ? 'dismissed' : 'resolved', resolvedBy: 'plugin', resolvedAt: now }),
                resolveNote: input.note ?? row.resolveNote,
                payload: json({ ...p, pluginState: 'closed' }),
                pluginState: { ...internalOf(row), ackedAt: now.getTime() },
                version: { increment: 1 }, updatedAt: now,
            },
        }) as AttentionRow;
        announce(tx, updated, false);
        return { item: decisionView(updated) };
    });
}

export async function listDecisions(install: InstallRow, input: { state?: 'open' | 'all'; limit?: number }) {
    const rows = await db.attentionItem.findMany({
        where: { pluginInstallId: install.id, source: 'plugin', ...(input.state === 'all' ? {} : { state: { in: ACTIVE } }) },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: input.limit ?? 50,
    });
    return { items: rows.map(r => decisionView(r as AttentionRow)) };
}

/** The delivery of a `decision.responded` event shows on its card (`payload.delivery`). */
export async function markDecisionDelivery(tx: Tx, install: InstallRow, itemId: string, delivery: 'delivered' | 'failed') {
    const item = await tx.attentionItem.findFirst({ where: { id: itemId, pluginInstallId: install.id } });
    const p = item ? parsePluginPayload(item.payload) : null;
    if (!item || !p) return;
    const updated = await tx.attentionItem.update({ where: { id: item.id }, data: { payload: json({ ...p, delivery }), version: { increment: 1 }, updatedAt: new Date() } }) as AttentionRow;
    afterTx(tx, () => emitPluginAttentionItem(install.accountId, itemView(updated)));
}

// ─── The owner answers (POST /v1/attention-items/:id/owner-respond on a plugin item) ────────────

export type PluginOwnerRespond =
    | { action: 'choose'; choice: string; note?: string }
    | { action: 'submit'; text: string; note?: string }
    | { action: 'resolve'; note?: string }
    | { action: string; [k: string]: unknown };

/**
 * The item becomes `responded` (resolved by the owner) and accepts no other answer; a `decision.responded`
 * event is queued for the plugin (§5.3). Only a signed-in person reaches this (route guard). A stopped
 * plugin's card cannot be answered: its cards are hidden.
 */
export async function ownerRespondPlugin(accountId: string, itemId: string, input: PluginOwnerRespond) {
    return runPluginTx(async tx => {
        const row = await tx.attentionItem.findFirst({ where: { id: itemId, accountId } }) as AttentionRow | null;
        requirePlugin(row && row.pluginInstallId, 'attention_item_not_found', 404);
        if (row.key === REVIEW_KEY) {
            // The host's review card: only「知道了」(the review page itself approves).
            requirePlugin(input.action === 'resolve', 'attention_check_unsupported', 409, { kind: row.kind });
            if (row.state === 'resolved') return { item: itemView(row) };
            const updated = await tx.attentionItem.update({ where: { id: row.id }, data: { state: 'resolved', resolvedBy: 'owner', resolvedAt: new Date(), version: { increment: 1 }, updatedAt: new Date() } }) as AttentionRow;
            announce(tx, updated, false);
            return { item: itemView(updated) };
        }
        const install = await loadInstall(tx, accountId, row.pluginInstallId);
        const block = installBlock(install);
        if (block) throw new PluginError(block, 409);
        const p = payloadOf(row);
        const open = p.pluginState === 'open' && ACTIVE.includes(row.state);
        const now = new Date();
        const note = typeof (input as { note?: unknown }).note === 'string' ? (input as { note: string }).note : undefined;
        let response: NonNullable<AttentionPluginPayload['response']>;
        if (input.action === 'choose') {
            const choice = String((input as { choice: string }).choice);
            requirePlugin(p.decisionKind === 'choice', 'attention_check_unsupported', 409, { kind: row.kind });
            requirePlugin(((row.options as Array<{ id: string }> | null) ?? []).some(o => o.id === choice), 'attention_unknown_choice', 400);
            if (!open) { requirePlugin(p.response?.action === 'choose' && p.response.choice === choice, 'attention_item_closed', 409); return { item: itemView(row) }; }
            response = { action: 'choose', choice, ...(note ? { note } : {}), at: now.getTime() };
        } else if (input.action === 'submit') {
            const text = String((input as { text: string }).text ?? '');
            requirePlugin(p.decisionKind === 'input', 'attention_check_unsupported', 409, { kind: row.kind });
            const max = p.input?.maxLength ?? PLUGIN_LIMITS.inputDefaultMaxLength;
            requirePlugin(text.length <= max, 'attention_body_too_large', 413, { max });
            if (!open) { requirePlugin(p.response?.action === 'submit' && p.response.text === text, 'attention_item_closed', 409); return { item: itemView(row) }; }
            response = { action: 'submit', text, ...(note ? { note } : {}), at: now.getTime() };
        } else if (input.action === 'resolve') {
            if (!open) return { item: itemView(row) };
            response = { action: 'dismiss', ...(note ? { note } : {}), at: now.getTime() };
        } else {
            // 追问 / check are host-card actions; a plugin reopens its own card with PATCH.
            throw new PluginError('attention_check_unsupported', 409, { kind: row.kind });
        }
        const updated = await tx.attentionItem.update({
            where: { id: row.id },
            data: {
                state: 'resolved', resolvedBy: 'owner', resolvedAt: now, ownerChoice: response.choice ?? null, ownerNote: note ?? null,
                payload: json({ ...p, pluginState: 'responded', delivery: 'pending', response }),
                pluginState: { push: internalOf(row).push },
                version: { increment: 1 }, updatedAt: now,
            },
        }) as AttentionRow;
        const eventId = await enqueueEvent(tx, install, 'decision.responded', {
            itemId: row.id, key: row.key, action: response.action,
            ...(response.choice ? { choice: response.choice } : {}),
            ...(response.text !== undefined ? { text: response.text } : {}),
            ...(note ? { note } : {}),
            respondedAt: now.getTime(), actor: 'owner',
        });
        await audit(tx, { accountId, installId: install.id, actor: 'owner', action: 'decision.responded', detail: { itemId: row.id, action: response.action, eventId } });
        announce(tx, updated, false);
        return { item: itemView(updated) };
    });
}
