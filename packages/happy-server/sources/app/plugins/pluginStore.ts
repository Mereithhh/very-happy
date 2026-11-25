import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
    parsePluginManifest, pluginManifestHash, pluginPrivilegedHash, PLUGIN_API_FEATURES, PLUGIN_API_VERSION, PLUGIN_LIMITS,
    type AttentionPluginReviewPayload, type PluginInstallView, type PluginManifest,
} from '@slopus/happy-wire';
import { db } from '@/storage/db';
import { afterTx, inTx, isRetryableTransactionConflict, type Tx } from '@/storage/inTx';
import { log } from '@/utils/log';
import { decryptWithDataKey } from '@/app/session/sessionCrypto';
import { openSessionDataKey } from '@/app/session/sessionShares';
import { itemView, type AttentionRow } from '@/app/attention/rules';
import { pluginHostConfig, pluginsEnabledFor } from './pluginConfig';
import {
    createWindowLimiter, effectiveGrants, effectiveState, hasGrant, installView, newInstallId, nextAttemptAt, originLabelFor,
    PluginError, requirePlugin, requireUsable, requiresApproval, validateGrants, type InstallRow,
} from './pluginRules';
import { emitPluginAttentionItem, emitPluginUpdate, emitPluginWidgetRemoved, emitToMachine } from './pluginSocket';

/**
 * B-974 plugin store (design B-973 §3, §5, §5.9–§5.10). Installs, audit, events, the badge and the
 * account-side actions. Plugin decisions and widgets are in pluginDecisions.ts / pluginWidgets.ts.
 * Every mutation runs in a SERIALIZABLE `inTx`; fan-out happens after commit. With plugins off for the
 * account nothing here writes (R-a: no `sessionId IS NULL` row is ever created while the switch is off).
 */

export type Actor = 'owner' | 'machine' | 'plugin' | 'operator';
const REVIEW_KEY = 'vh:install-review';

export function assertPluginsEnabled(accountId: string): void {
    requirePlugin(pluginsEnabledFor(accountId), 'plugins_disabled', 404);
}

export async function runPluginTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try { return await inTx(fn); }
        catch (error) {
            const unique = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
            if (unique && attempt < 3) continue;
            if (unique || isRetryableTransactionConflict(error)) throw new PluginError('transaction_conflict', 409);
            throw error;
        }
    }
}

export async function audit(tx: Tx, entry: { accountId: string; installId: string; actor: Actor; action: string; detail?: Record<string, unknown>; requestId?: string | null }): Promise<void> {
    await tx.pluginAudit.create({
        data: {
            id: randomUUID(), accountId: entry.accountId, installId: entry.installId, actor: entry.actor, action: entry.action,
            ...(entry.detail ? { detail: entry.detail as Prisma.InputJsonValue } : {}), requestId: entry.requestId ?? null,
        },
    });
}

export function view(row: InstallRow, withAddresses = false): PluginInstallView {
    return installView(row, pluginHostConfig(), process.env, withAddresses);
}

/** After commit: the account's plugin-aware Web gets the view; the hosting daemon re-syncs (r4 notice). */
export function announceInstall(tx: Tx, row: InstallRow): void {
    afterTx(tx, () => {
        emitPluginUpdate(row.accountId, { t: 'plugin-install', install: view(row) });
        emitToMachine(row.accountId, row.machineId, 'plugin-install-changed', { installId: row.id });
    });
}

export async function loadInstall(tx: Tx | typeof db, accountId: string, id: string): Promise<InstallRow> {
    const row = await tx.pluginInstall.findFirst({ where: { id, accountId } });
    requirePlugin(row, 'not_found', 404);
    return row as InstallRow;
}

// ─── Events (VH → plugin, design §5.5, r4: notice + pull) ────────────────────

export async function enqueueEvent(tx: Tx, install: Pick<InstallRow, 'id' | 'accountId' | 'machineId' | 'pluginId'>, type: string, data: Record<string, unknown>): Promise<string> {
    const last = await tx.pluginEvent.findFirst({ where: { installId: install.id }, orderBy: { seq: 'desc' }, select: { seq: true } });
    const id = `evt_${randomUUID().replace(/-/g, '')}`;
    await tx.pluginEvent.create({
        data: { id, installId: install.id, accountId: install.accountId, seq: (last?.seq ?? 0) + 1, type, data: data as Prisma.InputJsonValue },
    });
    afterTx(tx, () => emitToMachine(install.accountId, install.machineId, 'plugin-events-due', { installId: install.id }));
    return id;
}

async function installChanged(tx: Tx, row: InstallRow): Promise<void> {
    if (!row.manifestHash) return;
    await enqueueEvent(tx, row, 'install.changed', { state: effectiveState(row), grants: effectiveGrants(row), manifestHash: row.manifestHash });
}

// ─── Account (Web) side ──────────────────────────────────────────────────────

export async function listInstalls(accountId: string): Promise<{ installs: PluginInstallView[] }> {
    assertPluginsEnabled(accountId);
    const rows = await db.pluginInstall.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } });
    return { installs: rows.map(r => view(r as InstallRow)) };
}

/** r1 detail: the only response carrying upstream / callback addresses (the review and management pages). */
export async function installDetail(accountId: string, id: string) {
    assertPluginsEnabled(accountId);
    const row = await loadInstall(db, accountId, id);
    return {
        install: view(row, true),
        review: {
            manifest: row.pendingManifest ?? row.manifest,
            manifestHash: row.pendingManifestHash ?? row.manifestHash,
            approvedManifest: row.manifest ?? null,
            approvedHash: row.manifestHash,
            submittedAt: (row.pendingSubmittedAt ?? row.approvedAt ?? row.createdAt).getTime(),
            machineId: row.machineId,
        },
    };
}

export async function installAudit(accountId: string, id: string, limit = 100) {
    assertPluginsEnabled(accountId);
    await loadInstall(db, accountId, id);
    const [entries, reads] = await Promise.all([
        db.pluginAudit.findMany({ where: { installId: id, accountId }, orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(1, limit), 100) }),
        db.pluginAudit.findMany({ where: { installId: id, accountId, action: { in: ['sessions.read', 'sessions.list'] }, createdAt: { gt: new Date(Date.now() - 24 * 3600_000) } }, select: { detail: true } }),
    ]);
    const sessions = new Set<string>();
    for (const r of reads) for (const s of ((r.detail as { sessionIds?: string[] } | null)?.sessionIds ?? [])) sessions.add(s);
    return {
        entries: entries.map(e => ({ id: e.id, at: e.createdAt.getTime(), actor: e.actor, action: e.action, detail: e.detail ? JSON.stringify(e.detail) : null, requestId: e.requestId })),
        sensitiveReads24h: sessions.size,
    };
}

/** The review card's `plugin-review` payload (wire `AttentionPluginReviewPayloadSchema`). */
export function reviewCardPayload(pluginName: string, update: boolean): AttentionPluginReviewPayload {
    return { v: 1, type: 'plugin-review', pluginName: pluginName.slice(0, 64), update };
}

/** The host's own「插件安装待批准」card (design §2.2): source `owner-system`, never writable by the plugin (reserved `vh:` key). */
async function upsertReviewCard(tx: Tx, row: InstallRow, manifest: PluginManifest, update: boolean): Promise<void> {
    const now = new Date();
    // `title` is the fallback for a Web without `plugin-review` support; a current Web titles it from `payload` in its own language.
    const title = `${update ? '插件更新待批准' : '插件安装待批准'} · ${manifest.name}`.slice(0, 120);
    // Prisma types `payload` as the wrap-up shape (prisma-json-types); this card stores the wire review payload there.
    const payload = reviewCardPayload(manifest.name, update) as never;
    const links = [{ type: 'url', ref: `/settings/plugins/${row.id}/review`, label: '查看并批准' }] as never;
    const existing = await tx.attentionItem.findUnique({ where: { pluginInstallId_key: { pluginInstallId: row.id, key: REVIEW_KEY } } });
    const item = existing
        ? await tx.attentionItem.update({
            where: { id: existing.id },
            data: { title, links, payload, state: 'open', resolvedBy: null, resolvedAt: null, ownerChoice: null, pushedAt: null, version: { increment: 1 }, updatedAt: now },
        })
        : await tx.attentionItem.create({
            data: {
                id: randomUUID(), accountId: row.accountId, sessionId: null, pluginInstallId: row.id, source: 'owner-system', kind: 'todo', key: REVIEW_KEY,
                title, links, payload, needsOwner: true, state: 'open', createdAt: now, updatedAt: now,
            },
        });
    afterTx(tx, () => {
        emitPluginAttentionItem(row.accountId, itemView(item as AttentionRow));
        void pushReviewCard(item.id, row.accountId, title);
    });
}

async function pushReviewCard(id: string, accountId: string, title: string) {
    // The review card pushes even for a muted plugin: approving is the owner's own decision.
    try {
        const claimed = await db.attentionItem.updateMany({ where: { id, pushedAt: null }, data: { pushedAt: new Date() } });
        if (claimed.count !== 1) return;
        const { dispatchDeviceEventPush } = await import('@/app/push/pushDispatch');
        await dispatchDeviceEventPush({ userId: accountId, title: 'Very Happy', body: title, data: { kind: 'attention', itemId: id, url: '/settings/plugins' } });
    } catch (error) {
        log({ module: 'plugins', level: 'warn', error }, 'review push failed');
    }
}

async function closeReviewCard(tx: Tx, row: InstallRow, by: string): Promise<void> {
    const existing = await tx.attentionItem.findUnique({ where: { pluginInstallId_key: { pluginInstallId: row.id, key: REVIEW_KEY } } });
    if (!existing || existing.state === 'resolved' || existing.state === 'dismissed') return;
    const item = await tx.attentionItem.update({ where: { id: existing.id }, data: { state: 'resolved', resolvedBy: by, resolvedAt: new Date(), version: { increment: 1 }, updatedAt: new Date() } });
    afterTx(tx, () => emitPluginAttentionItem(row.accountId, itemView(item as AttentionRow)));
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

/**
 * POST /v1/plugins/installs (CLI `add` / `update`, machine token). §5.9 rules by `(machineId, manifest.id)`:
 *  - none (or removed): new `pending` install;
 *  - `rejected`: back to `pending`, a fresh review;
 *  - `enabled` / `update_pending`: privileged change → `update_pending` (old approval keeps working); otherwise in
 *    force at once (a reduction drops the revoked grants);
 *  - `disabled`: stays disabled; the change waits in `pendingManifest` for the owner's re-enable + review;
 *  - operator-blocked: nothing changes.
 */
export async function submitInstall(accountId: string, input: { machineId: string; manifest: unknown; requestId?: string }): Promise<{ installId: string; state: string; reviewUrl: string; manifestHash: string; install: PluginInstallView }> {
    assertPluginsEnabled(accountId);
    requirePlugin(Buffer.byteLength(JSON.stringify(input.manifest ?? null), 'utf8') <= PLUGIN_LIMITS.manifestBytes, 'payload_too_large', 413);
    const parsed = parsePluginManifest(input.manifest);
    if (!parsed.ok) throw new PluginError(parsed.error === 'invalid_manifest' ? 'invalid_request' : parsed.error, parsed.error === 'payload_too_large' ? 413 : 400, { message: parsed.message, ...(parsed.issues ? { issues: parsed.issues } : {}) });
    const manifest = parsed.manifest;
    requirePlugin(manifest.minApi <= PLUGIN_API_VERSION, 'api_too_old', 400, { minApi: manifest.minApi, apiVersion: PLUGIN_API_VERSION });
    const hash = pluginManifestHash(manifest);
    const pHash = pluginPrivilegedHash(manifest);
    return runPluginTx(async tx => {
        const machine = await tx.machine.findFirst({ where: { id: input.machineId, accountId }, select: { id: true } });
        requirePlugin(machine, 'machine_not_found', 404);
        const existing = await tx.pluginInstall.findUnique({ where: { machineId_pluginId: { machineId: input.machineId, pluginId: manifest.id } } }) as InstallRow | null;
        requirePlugin(!existing || existing.accountId === accountId, 'not_found', 404);
        const now = new Date();
        let row: InstallRow;
        let action: string;
        if (!existing) {
            const id = newInstallId();
            row = await tx.pluginInstall.create({
                data: { id, accountId, machineId: input.machineId, pluginId: manifest.id, state: 'pending', pendingManifest: json(manifest), pendingManifestHash: hash, pendingSubmittedAt: now, originLabel: originLabelFor(manifest.id, id), createdAt: now, updatedAt: now },
            }) as InstallRow;
            action = 'install.submitted';
            await upsertReviewCard(tx, row, manifest, false);
        } else if (effectiveState(existing) === 'disabled_by_operator') {
            return result(existing);
        } else {
            const approved = existing.manifest as PluginManifest | null;
            if (existing.manifestHash === hash && !existing.pendingManifest) return result(existing);
            if (existing.pendingManifestHash === hash) return result(existing);
            const applyNow = approved && existing.state !== 'disabled' && existing.state !== 'rejected' && !requiresApproval(approved, manifest);
            if (applyNow) {
                const panel = (manifest.permissions as string[]).includes('panel');
                row = await tx.pluginInstall.update({
                    where: { id: existing.id },
                    data: {
                        manifest: json(manifest), manifestHash: hash, privilegedHash: pHash,
                        grants: existing.grants.filter(g => (manifest.permissions as string[]).includes(g)),
                        pendingManifest: Prisma.DbNull, pendingManifestHash: null, pendingSubmittedAt: null,
                        ...(existing.state === 'update_pending' ? { state: 'enabled' } : {}),
                        ...(!panel ? { frameEpoch: { increment: 1 } } : {}),
                        version: { increment: 1 }, updatedAt: now,
                    },
                }) as InstallRow;
                action = 'install.updated';
                await closeReviewCard(tx, row, 'machine');
                await installChanged(tx, row);
            } else {
                const state = !approved || existing.state === 'rejected' ? 'pending' : existing.state === 'disabled' ? 'disabled' : 'update_pending';
                row = await tx.pluginInstall.update({
                    where: { id: existing.id },
                    data: { pendingManifest: json(manifest), pendingManifestHash: hash, pendingSubmittedAt: now, state, version: { increment: 1 }, updatedAt: now },
                }) as InstallRow;
                action = state === 'pending' ? 'install.resubmitted' : 'install.update_submitted';
                if (state !== 'disabled') await upsertReviewCard(tx, row, manifest, !!approved);
            }
        }
        await audit(tx, { accountId, installId: row.id, actor: 'machine', action, detail: { manifestHash: hash, version: manifest.version, machineId: input.machineId }, requestId: input.requestId });
        announceInstall(tx, row);
        return result(row);
    });
    function result(row: InstallRow) {
        return { installId: row.id, state: effectiveState(row), reviewUrl: `/settings/plugins/${row.id}/review`, manifestHash: hash, install: view(row) };
    }
}

/** POST /v1/plugins/installs/:id/approve (signed-in person only — enforced by the route). */
export async function approveInstall(accountId: string, id: string, input: { grants: string[]; manifestHash: string }): Promise<{ install: PluginInstallView }> {
    assertPluginsEnabled(accountId);
    return runPluginTx(async tx => {
        const row = await loadInstall(tx, accountId, id);
        const pending = row.pendingManifest as PluginManifest | null;
        requirePlugin(pending && row.pendingManifestHash, 'nothing_to_approve', 409);
        requirePlugin(row.pendingManifestHash === input.manifestHash, 'manifest_changed', 409, { manifestHash: row.pendingManifestHash });
        requirePlugin(effectiveState(row) !== 'disabled_by_operator', 'disabled_by_operator', 403);
        const grants = validateGrants(input.grants, pending);
        const now = new Date();
        const revokedPanel = row.grants.includes('panel') && !grants.includes('panel');
        const updated = await tx.pluginInstall.update({
            where: { id },
            data: {
                manifest: json(pending), manifestHash: row.pendingManifestHash, privilegedHash: pluginPrivilegedHash(pending), grants,
                pendingManifest: Prisma.DbNull, pendingManifestHash: null, pendingSubmittedAt: null,
                // Approving does not lift the owner's own「停用」.
                state: row.state === 'disabled' ? 'disabled' : 'enabled',
                approvedAt: now, ...(revokedPanel ? { frameEpoch: { increment: 1 } } : {}),
                version: { increment: 1 }, updatedAt: now,
            },
        }) as InstallRow;
        await closeReviewCard(tx, updated, 'owner');
        await audit(tx, { accountId, installId: id, actor: 'owner', action: 'install.approved', detail: { grants, manifestHash: updated.manifestHash } });
        await installChanged(tx, updated);
        announceInstall(tx, updated);
        return { install: view(updated) };
    });
}

/** Reject the pending version: a first install becomes `rejected`; a rejected update leaves the old approval in force. */
export async function rejectInstall(accountId: string, id: string): Promise<{ install: PluginInstallView }> {
    assertPluginsEnabled(accountId);
    return runPluginTx(async tx => {
        const row = await loadInstall(tx, accountId, id);
        requirePlugin(row.pendingManifest, 'nothing_to_approve', 409);
        const updated = await tx.pluginInstall.update({
            where: { id },
            data: {
                pendingManifest: Prisma.DbNull, pendingManifestHash: null, pendingSubmittedAt: null,
                state: row.manifest ? (row.state === 'update_pending' ? 'enabled' : row.state) : 'rejected',
                version: { increment: 1 }, updatedAt: new Date(),
            },
        }) as InstallRow;
        await closeReviewCard(tx, updated, 'owner');
        await audit(tx, { accountId, installId: id, actor: 'owner', action: 'install.rejected' });
        announceInstall(tx, updated);
        return { install: view(updated) };
    });
}

/** Account- or machine-side stop (§3.4): API calls and forwarding refused at once; every frame session voided; items hidden. */
export async function disableInstall(accountId: string, id: string, input: { reason?: string }, actor: Actor, onlyMachineId?: string): Promise<{ install: PluginInstallView }> {
    assertPluginsEnabled(accountId);
    return runPluginTx(async tx => {
        const row = await loadInstall(tx, accountId, id);
        if (onlyMachineId !== undefined) requirePlugin(row.machineId === onlyMachineId, 'not_found', 404);
        if (row.state === 'disabled') return { install: view(row) };
        const reason = input.reason?.slice(0, PLUGIN_LIMITS.reasonChars);
        const updated = await tx.pluginInstall.update({
            where: { id },
            data: { state: 'disabled', disabledBy: actor, disabledReason: reason ?? null, frameEpoch: { increment: 1 }, version: { increment: 1 }, updatedAt: new Date() },
        }) as InstallRow;
        await audit(tx, { accountId, installId: id, actor, action: 'install.disabled', ...(reason ? { detail: { reason } } : {}) });
        await installChanged(tx, updated);
        announceInstall(tx, updated);
        return { install: view(updated) };
    });
}

/**
 * Re-enable. A change submitted while disabled (§5.9) waits for review: the install goes to `update_pending`.
 * The owner lifts any owner / machine disable. A machine (`byMachineId`) lifts only its own local disable:
 * the install must sit on that machine and have been disabled by a machine — anything else is
 * 403 `enable_requires_owner`. The operator's switch is lifted by nobody here (409 `disabled_by_operator`).
 */
export async function enableInstall(accountId: string, id: string, byMachineId?: string): Promise<{ install: PluginInstallView }> {
    assertPluginsEnabled(accountId);
    const actor: Actor = byMachineId === undefined ? 'owner' : 'machine';
    return runPluginTx(async tx => {
        const row = await loadInstall(tx, accountId, id);
        if (byMachineId !== undefined) requirePlugin(row.machineId === byMachineId, 'enable_requires_owner', 403);
        requirePlugin(effectiveState(row) !== 'disabled_by_operator', 'disabled_by_operator', 409);
        requirePlugin(row.state === 'disabled', 'not_disabled', 409, { state: row.state });
        if (byMachineId !== undefined) requirePlugin(row.disabledBy === 'machine', 'enable_requires_owner', 403);
        requirePlugin(row.manifest, 'plugin_pending', 409);
        const updated = await tx.pluginInstall.update({
            where: { id },
            data: { state: row.pendingManifest ? 'update_pending' : 'enabled', disabledBy: null, disabledReason: null, version: { increment: 1 }, updatedAt: new Date() },
        }) as InstallRow;
        if (row.pendingManifest) await upsertReviewCard(tx, updated, row.pendingManifest as PluginManifest, true);
        await audit(tx, { accountId, installId: id, actor, action: 'install.enabled' });
        await installChanged(tx, updated);
        announceInstall(tx, updated);
        return { install: view(updated) };
    });
}

/**
 * DELETE /v1/plugins/installs/:id. The install, its events and widgets go; its cards are dismissed unless
 * `keepItems` (the audit trail stays). The daemon drops the credentials on the `plugin-install-changed` sync.
 */
export async function removeInstall(accountId: string, id: string, input: { keepItems?: boolean }, actor: Actor, onlyMachineId?: string): Promise<{ removed: true }> {
    assertPluginsEnabled(accountId);
    return runPluginTx(async tx => {
        const row = await loadInstall(tx, accountId, id);
        if (onlyMachineId !== undefined) requirePlugin(row.machineId === onlyMachineId, 'not_found', 404);
        const widgets = await tx.pluginWidget.findMany({ where: { installId: id }, select: { sessionId: true } });
        const now = new Date();
        const items = await tx.attentionItem.findMany({ where: { accountId, pluginInstallId: id, state: { in: ['open', 'in_progress', 'answered'] }, ...(input.keepItems ? { key: REVIEW_KEY } : {}) } });
        const closed: AttentionRow[] = [];
        for (const item of items) closed.push(await tx.attentionItem.update({ where: { id: item.id }, data: { state: 'dismissed', resolvedBy: 'plugin-removed', resolvedAt: now, version: { increment: 1 }, updatedAt: now } }) as AttentionRow);
        await tx.pluginInstall.delete({ where: { id } });
        await audit(tx, { accountId, installId: id, actor, action: 'install.removed', detail: { keepItems: input.keepItems === true } });
        afterTx(tx, () => {
            emitPluginUpdate(accountId, { t: 'plugin-install', installId: id, removed: true });
            for (const w of widgets) emitPluginWidgetRemoved(accountId, id, w.sessionId);
            for (const item of closed) emitPluginAttentionItem(accountId, itemView(item));
            emitToMachine(accountId, row.machineId, 'plugin-install-changed', { installId: id });
        });
        return { removed: true as const };
    });
}

/** Revoke some grants (= a reduction, §3.4): immediate; revoking `panel` voids every frame session. */
export async function revokeGrants(accountId: string, id: string, revoke: string[]): Promise<{ install: PluginInstallView }> {
    assertPluginsEnabled(accountId);
    return runPluginTx(async tx => {
        const row = await loadInstall(tx, accountId, id);
        const grants = row.grants.filter(g => !revoke.includes(g));
        if (grants.length === row.grants.length) return { install: view(row) };
        const updated = await tx.pluginInstall.update({
            where: { id },
            data: { grants, ...(revoke.includes('panel') ? { frameEpoch: { increment: 1 } } : {}), version: { increment: 1 }, updatedAt: new Date() },
        }) as InstallRow;
        await audit(tx, { accountId, installId: id, actor: 'owner', action: 'grants.revoked', detail: { revoked: row.grants.filter(g => revoke.includes(g)) } });
        await installChanged(tx, updated);
        announceInstall(tx, updated);
        return { install: view(updated) };
    });
}

export async function muteInstall(accountId: string, id: string, muted: boolean): Promise<{ install: PluginInstallView }> {
    assertPluginsEnabled(accountId);
    return runPluginTx(async tx => {
        const row = await loadInstall(tx, accountId, id);
        if (row.muted === muted) return { install: view(row) };
        const updated = await tx.pluginInstall.update({ where: { id }, data: { muted, version: { increment: 1 }, updatedAt: new Date() } }) as InstallRow;
        await audit(tx, { accountId, installId: id, actor: 'owner', action: muted ? 'install.muted' : 'install.unmuted' });
        announceInstall(tx, updated);
        return { install: view(updated) };
    });
}

// ─── Machine side ────────────────────────────────────────────────────────────

/**
 * The install a machine op names, checked against the socket's identity (§5.6): same account, same machine,
 * a usable state. Another machine's install answers `not_found` (no oracle). Permissions are the op handler's.
 */
export async function machineInstall(accountId: string, machineId: string, installId: string | null | undefined): Promise<InstallRow> {
    requirePlugin(installId, 'invalid_request', 400, { issues: [{ path: ['installId'], message: 'required' }] });
    const row = await db.pluginInstall.findFirst({ where: { id: installId, accountId } }) as InstallRow | null;
    requirePlugin(row && row.machineId === machineId, 'not_found', 404);
    requireUsable(row);
    return row;
}

const SEEN_WRITE_MS = 60_000;
export async function touchSeen(row: InstallRow): Promise<void> {
    if (row.lastSeenAt && Date.now() - row.lastSeenAt.getTime() < SEEN_WRITE_MS) return;
    try { await db.pluginInstall.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } }); } catch { /* removed meanwhile */ }
}

/** `install.sync` (r4): every install on this machine, with the approved manifest (the daemon forwards and checks with it). */
export async function syncMachineInstalls(accountId: string, machineId: string) {
    const rows = await db.pluginInstall.findMany({ where: { accountId, machineId } }) as InstallRow[];
    return {
        installs: rows.map(r => {
            const state = effectiveState(r);
            const disabledBy = state === 'disabled_by_operator' ? 'operator' : r.disabledBy === 'owner' || r.disabledBy === 'machine' ? r.disabledBy : undefined;
            return {
                id: r.id, pluginId: r.pluginId, state, grants: effectiveGrants(r), manifest: r.manifest ?? null, manifestHash: r.manifestHash,
                pending: !!r.pendingManifest, ...(disabledBy ? { disabledBy } : {}),
            };
        }),
    };
}

export function installInfo(row: InstallRow) {
    return {
        apiVersion: PLUGIN_API_VERSION, features: [...PLUGIN_API_FEATURES], installId: row.id, pluginId: row.pluginId,
        state: effectiveState(row), grants: effectiveGrants(row), machineId: row.machineId,
    };
}

const badgeLimiter = createWindowLimiter(PLUGIN_LIMITS.badgeWritesPerMinute, 60_000);

export async function putBadge(row: InstallRow, input: { count: number | null; tone?: 'default' | 'attention'; label?: string }) {
    const limited = badgeLimiter.take(row.id);
    if (!limited.ok) throw new PluginError('rate_limited', 429, { retryAfterMs: limited.retryAfterMs });
    const current = row.badge as { count: number | null; tone: string; label: string | null; updatedAt: number } | null;
    const next = { count: input.count, tone: input.tone ?? 'default', label: input.label ?? null };
    // Same value again: dropped, no broadcast (§5.2).
    if (current && current.count === next.count && current.tone === next.tone && current.label === next.label) return { badge: current };
    if (!current && input.count === null) return { badge: { ...next, updatedAt: Date.now() } };
    const badge = input.count === null ? null : { ...next, updatedAt: Date.now() };
    return runPluginTx(async tx => {
        const updated = await tx.pluginInstall.update({ where: { id: row.id }, data: { badge: badge ?? Prisma.DbNull, lastSeenAt: new Date() } }) as InstallRow;
        afterTx(tx, () => emitPluginUpdate(row.accountId, { t: 'plugin-install', install: view(updated) }));
        return { badge: badge ?? { ...next, updatedAt: Date.now() } };
    });
}

/** Unsigned envelope (wire `PluginEventReadSchema`); the daemon signs it when it pushes or serves it. */
function eventEnvelope(e: { id: string; type: string; data: unknown; attempts: number; createdAt: Date }, row: InstallRow) {
    return { id: e.id, type: e.type, installId: row.id, pluginId: row.pluginId, createdAt: e.createdAt.getTime(), attempt: e.attempts + 1, data: e.data };
}

function cursorOf(after: string | undefined): number {
    const n = after === undefined ? 0 : Number(after);
    requirePlugin(Number.isSafeInteger(n) && n >= 0, 'invalid_request', 400, { issues: [{ path: ['after'], message: 'unknown cursor' }] });
    return n;
}

/**
 * `events.pull` (r4): due events after the cursor — not acknowledged, not settled, and past their backoff.
 * The same call feeds the daemon's push loop and a plugin's own `GET /plugin/v1/events`.
 */
export async function pullEvents(row: InstallRow, input: { after?: string; limit?: number }) {
    const after = cursorOf(input.after);
    const events = await db.pluginEvent.findMany({
        where: { installId: row.id, ackedAt: null, delivery: 'pending', seq: { gt: after }, nextAttemptAt: { lte: new Date() } },
        orderBy: { seq: 'asc' }, take: input.limit ?? 50,
    });
    return { events: events.map(e => eventEnvelope(e, row)), cursor: events.length ? String(events[events.length - 1].seq) : (input.after ?? null) };
}

export async function ackEvents(row: InstallRow, upTo: string) {
    const upToSeq = cursorOf(upTo);
    const now = new Date();
    return runPluginTx(async tx => {
        const acked = await tx.pluginEvent.findMany({ where: { installId: row.id, ackedAt: null, seq: { lte: upToSeq } }, select: { id: true, type: true, data: true } });
        if (acked.length === 0) return { acked: 0 };
        await tx.pluginEvent.updateMany({ where: { id: { in: acked.map(a => a.id) } }, data: { ackedAt: now, delivery: 'delivered', deliveredAt: now } });
        const { markDecisionDelivery } = await import('./pluginDecisions');
        for (const e of acked) if (e.type === 'decision.responded') await markDecisionDelivery(tx, row, (e.data as { itemId: string }).itemId, 'delivered');
        return { acked: acked.length };
    });
}

/** The daemon's push outcome for one event (r4): delivered, or the next try per the §5.5 schedule (failed after 24 h). */
export async function eventResult(row: InstallRow, input: { eventId: string; status: 'delivered' | 'failed'; attempt: number; error?: string }) {
    return runPluginTx(async tx => {
        const event = await tx.pluginEvent.findFirst({ where: { id: input.eventId, installId: row.id } });
        requirePlugin(event, 'not_found', 404);
        if (event.delivery !== 'pending') return { delivery: event.delivery };
        const now = Date.now();
        const { markDecisionDelivery } = await import('./pluginDecisions');
        const itemId = event.type === 'decision.responded' ? (event.data as { itemId?: string }).itemId : undefined;
        if (input.status === 'delivered') {
            await tx.pluginEvent.update({ where: { id: event.id }, data: { delivery: 'delivered', deliveredAt: new Date(now), attempts: { increment: 1 } } });
            if (itemId) await markDecisionDelivery(tx, row, itemId, 'delivered');
            return { delivery: 'delivered' };
        }
        const attempts = event.attempts + 1;
        // r6: the daemon retries on its own schedule while online and says `gave_up` when it stops — that is final.
        const next = input.error === 'gave_up' ? null : nextAttemptAt(event.createdAt.getTime(), attempts, now);
        await tx.pluginEvent.update({
            where: { id: event.id },
            data: { attempts, lastError: input.error?.slice(0, 200) ?? null, ...(next === null ? { delivery: 'failed' } : { nextAttemptAt: new Date(next) }) },
        });
        if (next === null && itemId) await markDecisionDelivery(tx, row, itemId, 'failed');
        return { delivery: next === null ? 'failed' : 'pending', ...(next !== null ? { nextAttemptAt: next } : {}) };
    });
}

/**
 * Server-side fallback (r6): the daemon owns retries while online. An event past its retry time whose machine has
 * been offline for more than 24 h is marked failed here; a due retry on an online machine gets a nudge.
 */
export async function sweepPluginEvents(now = Date.now()): Promise<number> {
    const dayAgo = new Date(now - 24 * 3600_000);
    const stale = await db.pluginEvent.findMany({
        where: { delivery: 'pending', ackedAt: null, createdAt: { lt: dayAgo }, nextAttemptAt: { lte: new Date(now) } },
        select: { id: true, install: { select: { accountId: true, machineId: true } } }, take: 1000,
    });
    const offline = new Set<string>();
    for (const m of new Set(stale.map(e => `${e.install.accountId}\u0000${e.install.machineId}`))) {
        const [accountId, machineId] = m.split('\u0000');
        const machine = await db.machine.findFirst({ where: { id: machineId, accountId }, select: { lastActiveAt: true } });
        if (!machine || machine.lastActiveAt < dayAgo) offline.add(m);
    }
    const ids = stale.filter(e => offline.has(`${e.install.accountId}\u0000${e.install.machineId}`)).map(e => e.id);
    const failed = ids.length ? await db.pluginEvent.updateMany({ where: { id: { in: ids } }, data: { delivery: 'failed' } }) : { count: 0 };
    const due = await db.pluginEvent.findMany({
        where: { delivery: 'pending', ackedAt: null, attempts: { gt: 0 }, nextAttemptAt: { lte: new Date(now) } },
        distinct: ['installId'], select: { installId: true, install: { select: { accountId: true, machineId: true } } }, take: 500,
    });
    for (const d of due) emitToMachine(d.install.accountId, d.install.machineId, 'plugin-events-due', { installId: d.installId });
    return failed.count + due.length;
}

let sweeper: ReturnType<typeof setInterval> | null = null;
export function startPluginEventSweeper(): void {
    if (sweeper) return;
    sweeper = setInterval(() => { void sweepPluginEvents().catch(error => log({ module: 'plugins', level: 'warn', error }, 'plugin event sweep failed')); }, 30_000);
    sweeper.unref?.();
}
export function stopPluginEventSweeper(): void {
    if (sweeper) clearInterval(sweeper);
    sweeper = null;
}

/** §5.7 / §5.9: a sensitive read is audited before the daemon returns any data (the ack comes after the row is written). */
export async function recordSensitiveRead(row: InstallRow, input: { permission: 'sessions.list' | 'sessions.read'; sessionIds: string[] }, requestId?: string) {
    requirePlugin(hasGrant(row, input.permission), 'permission_denied', 403, { permission: input.permission });
    await runPluginTx(tx => audit(tx, { accountId: row.accountId, installId: row.id, actor: 'plugin', action: input.permission, detail: { sessionIds: input.sessionIds.slice(0, 100), count: input.sessionIds.length }, requestId }));
    return {};
}

// ─── Sessions on the machine (widgets, decision links) ───────────────────────

/**
 * Whether `sessionId` is the account's and runs on `machineId` (design §5.4 second check). `Session` has no
 * plaintext machine column; the server opens the session's metadata with its DEK (server-trusted). A session
 * it cannot open (legacy, no DEK) is refused — plugins need a current CLI anyway.
 */
export async function requireSessionOnMachine(accountId: string, machineId: string, sessionId: string): Promise<{ archived: boolean }> {
    const session = await db.session.findFirst({ where: { id: sessionId, accountId }, select: { id: true, accountId: true, dataEncryptionKey: true, metadata: true, archivedAt: true } });
    requirePlugin(session, 'not_found', 404);
    let onMachine = false;
    try {
        const dek = await openSessionDataKey(session);
        const metadata = dek ? decryptWithDataKey(new Uint8Array(Buffer.from(session.metadata, 'base64')), dek) as { machineId?: unknown } | null : null;
        onMachine = metadata?.machineId === machineId;
    } catch {
        onMachine = false;
    }
    requirePlugin(onMachine, 'session_not_on_machine', 403);
    return { archived: session.archivedAt !== null };
}
