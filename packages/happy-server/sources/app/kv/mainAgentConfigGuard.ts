/**
 * B-922 (specs/2026-11-main-agent.md §4.4): only the owner, in a browser, may
 * loosen the main agent safety setting. A machine token (the main agent's own
 * wrapper, a daemon, a script) writing `vh.main-agent-config.*` may tighten
 * freely; the one loosening it may make is adding to `safety.allowedTools` a
 * tool the owner chose "以后都允许这个工具" for on a gate-1 card
 * (`main-agent-tool:<approvalId>:<tool>`, resolved by the owner with `always`).
 * Only `safety` and `deniedTools` are compared; `quietHours`, `skillRoots` and
 * any other field are free. `/v1/kv/bulk` is a read, so this is the only path.
 *
 * A grant is spent and dated (QA P2-1): an `always` card counts only when it
 * was resolved AFTER the last human write of that config key (so an owner
 * removing a tool voids every older card for it) and only once (redeemed card
 * ids are recorded). Both live in the server-owned KV record
 * `vh.main-agent-grants.v1`, which no client token may write.
 */

import {
    isLoosening,
    MAIN_AGENT_CONFIG_KEY_PREFIX,
    MAIN_AGENT_TOOL_ALWAYS_CHOICE,
    MAIN_AGENT_TOOL_CARD_KEY_PREFIX,
    mainAgentConfigLoosening,
    toolNameFromToolCardKey,
    unreadableSafetySection,
} from '@slopus/happy-wire';
import { db } from '@/storage/db';
import { kvGet } from './kvGet';
import { kvMutate } from './kvMutate';

export const MAIN_AGENT_CONFIG_OWNER_ONLY = 'main_agent_config_owner_only' as const;
/** Server-owned record of grant state; never writable by a client. */
export const MAIN_AGENT_GRANTS_KEY = 'vh.main-agent-grants.v1';
export const SERVER_OWNED_KV_KEY = 'server_owned_kv_key' as const;
export const REDEEMED_MAX = 500;

export type GrantsRecord = { v: 1; humanWriteAt: Record<string, number>; redeemed: string[] };
export type GrantCard = { id: string; tool: string; resolvedAt: number };

export function parseGrantsRecord(raw: unknown): GrantsRecord {
    const out: GrantsRecord = { v: 1, humanWriteAt: {}, redeemed: [] };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const r = raw as Record<string, unknown>;
    if (r.humanWriteAt && typeof r.humanWriteAt === 'object' && !Array.isArray(r.humanWriteAt)) {
        for (const [k, v] of Object.entries(r.humanWriteAt as Record<string, unknown>)) if (typeof v === 'number' && Number.isFinite(v)) out.humanWriteAt[k] = v;
    }
    if (Array.isArray(r.redeemed)) out.redeemed = r.redeemed.filter((x): x is string => typeof x === 'string').slice(-REDEEMED_MAX);
    return out;
}

/** Cards still able to grant for `key`: resolved after its last human write, never redeemed. */
export function liveGrants(cards: readonly GrantCard[], record: GrantsRecord, key: string): GrantCard[] {
    const since = record.humanWriteAt[key] ?? 0;
    const spent = new Set(record.redeemed);
    return cards.filter((c) => c.resolvedAt > since && !spent.has(c.id));
}

export function isMainAgentConfigKey(key: string): boolean {
    return key.startsWith(MAIN_AGENT_CONFIG_KEY_PREFIX);
}

/** base64 UTF-8 JSON → value; undefined when it is not JSON. */
export function decodeKvJsonValue(value: string): unknown {
    try { return JSON.parse(Buffer.from(value, 'base64').toString('utf8')); } catch { return undefined; }
}

/** Pure part: is this write (prev → next) refused for a machine token? */
export function machineConfigWriteRefused(prev: unknown, next: unknown, grantedTools: ReadonlySet<string>): boolean {
    // an unreadable replacement cannot be compared: refuse rather than guess
    if (next === undefined) return true;
    // a safety section (or value shape) this server cannot read counts as looser: fail-closed.
    // Other fields (skillRoots, quietHours, …) are never compared.
    if (unreadableSafetySection(next)) return true;
    const loosening = mainAgentConfigLoosening(prev, next);
    if (!isLoosening(loosening)) return false;
    if (loosening.policy.length > 0 || loosening.removedDeniedTools.length > 0) return true;
    return loosening.addedAllowedTools.some((tool) => !grantedTools.has(tool.toLowerCase()));
}

/** Gate-1 cards of this account the owner resolved with "always". */
export async function ownerAlwaysCards(accountId: string): Promise<GrantCard[]> {
    const rows = await db.attentionItem.findMany({
        where: { accountId, key: { startsWith: MAIN_AGENT_TOOL_CARD_KEY_PREFIX }, state: 'resolved', resolvedBy: 'owner', ownerChoice: MAIN_AGENT_TOOL_ALWAYS_CHOICE },
        select: { id: true, key: true, resolvedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 500,
    });
    const out: GrantCard[] = [];
    for (const row of rows) {
        const tool = toolNameFromToolCardKey(row.key);
        const resolvedAt = row.resolvedAt instanceof Date ? row.resolvedAt.getTime() : typeof row.resolvedAt === 'number' ? row.resolvedAt : NaN;
        if (tool && Number.isFinite(resolvedAt)) out.push({ id: row.id, tool: tool.toLowerCase(), resolvedAt });
    }
    return out;
}

export async function readGrantsRecord(accountId: string): Promise<{ record: GrantsRecord; version: number }> {
    const cur = await kvGet({ uid: accountId }, MAIN_AGENT_GRANTS_KEY);
    return { record: parseGrantsRecord(cur ? decodeKvJsonValue(cur.value) : null), version: cur ? cur.version : -1 };
}

/** Read-modify-write of the grants record (one retry on a version race). Throws when it cannot be written. */
export async function updateGrantsRecord(accountId: string, change: (r: GrantsRecord) => GrantsRecord): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const { record, version } = await readGrantsRecord(accountId);
        const next = change(record);
        next.redeemed = next.redeemed.slice(-REDEEMED_MAX);
        const res = await kvMutate({ uid: accountId }, [{ key: MAIN_AGENT_GRANTS_KEY, value: Buffer.from(JSON.stringify(next), 'utf8').toString('base64'), version }]);
        if (res.success) return;
    }
    throw new Error('grants_record_conflict');
}

/** Before a human write: stamp it first, so a later failure can only make old cards stricter. */
export async function noteHumanConfigWrite(accountId: string, mutations: ReadonlyArray<{ key: string }>, now = Date.now()): Promise<void> {
    const keys = mutations.map((m) => m.key).filter(isMainAgentConfigKey);
    if (keys.length === 0) return;
    await updateGrantsRecord(accountId, (r) => ({ ...r, humanWriteAt: { ...r.humanWriteAt, ...Object.fromEntries(keys.map((k) => [k, now])) } }));
}

export function isServerOwnedKvKey(key: string): boolean {
    return key === MAIN_AGENT_GRANTS_KEY;
}

/**
 * Check a machine-token batch. `refused` = the first config key it may not
 * write; otherwise `redeem` = the grant cards this write spends (recorded after
 * the write succeeds). Compared against the stored value; a stale `version`
 * fails in kvMutate anyway.
 */
export async function checkMachineConfigWrite(accountId: string, mutations: ReadonlyArray<{ key: string; value: string | null }>): Promise<{ refused: string | null; redeem: string[] }> {
    let cards: GrantCard[] | null = null;
    let grants: GrantsRecord | null = null;
    const redeem: string[] = [];
    for (const m of mutations) {
        if (!isMainAgentConfigKey(m.key)) continue;
        const current = await kvGet({ uid: accountId }, m.key);
        const prev = current ? decodeKvJsonValue(current.value) ?? null : null;
        const next = m.value === null ? null : decodeKvJsonValue(m.value);
        if (!machineConfigWriteRefused(prev, next, new Set())) continue;
        cards ??= await ownerAlwaysCards(accountId);
        grants ??= (await readGrantsRecord(accountId)).record;
        const live = liveGrants(cards, grants, m.key);
        if (machineConfigWriteRefused(prev, next, new Set(live.map((c) => c.tool)))) return { refused: m.key, redeem: [] };
        // spend one live card per newly allowed tool
        for (const tool of mainAgentConfigLoosening(prev, next).addedAllowedTools) {
            const card = live.find((c) => c.tool === tool.toLowerCase() && !redeem.includes(c.id));
            if (card) redeem.push(card.id);
        }
    }
    return { refused: null, redeem };
}

/** Kept for callers that only need the verdict. */
export async function refusedMachineConfigWrite(accountId: string, mutations: ReadonlyArray<{ key: string; value: string | null }>): Promise<string | null> {
    return (await checkMachineConfigWrite(accountId, mutations)).refused;
}
