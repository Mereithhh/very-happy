/**
 * B-922 (specs/2026-11-main-agent.md §4.4): only the owner, in a browser, may
 * loosen the main agent safety setting. A machine token (the main agent's own
 * wrapper, a daemon, a script) writing `vh.main-agent-config.*` may tighten
 * freely; the one loosening it may make is adding to `safety.allowedTools` a
 * tool the owner chose "以后都允许这个工具" for on a gate-1 card
 * (`main-agent-tool:<approvalId>:<tool>`, resolved by the owner with `always`).
 * Only `safety` and `deniedTools` are compared; `quietHours`, `skillRoots` and
 * any other field are free. `/v1/kv/bulk` is a read, so this is the only path.
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

export const MAIN_AGENT_CONFIG_OWNER_ONLY = 'main_agent_config_owner_only' as const;

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

/** Tools the owner granted "always" on a gate-1 card of this account. */
export async function ownerGrantedTools(accountId: string): Promise<Set<string>> {
    const rows = await db.attentionItem.findMany({
        where: { accountId, key: { startsWith: MAIN_AGENT_TOOL_CARD_KEY_PREFIX }, state: 'resolved', resolvedBy: 'owner', ownerChoice: MAIN_AGENT_TOOL_ALWAYS_CHOICE },
        select: { key: true },
        orderBy: { updatedAt: 'desc' },
        take: 500,
    });
    const out = new Set<string>();
    for (const row of rows) {
        const tool = toolNameFromToolCardKey(row.key);
        if (tool) out.add(tool.toLowerCase());
    }
    return out;
}

/**
 * The first main-agent-config mutation a machine token may not make, or null.
 * Compared against the stored value; a stale `version` fails in kvMutate anyway.
 */
export async function refusedMachineConfigWrite(accountId: string, mutations: ReadonlyArray<{ key: string; value: string | null }>): Promise<string | null> {
    let granted: Set<string> | null = null;
    for (const m of mutations) {
        if (!isMainAgentConfigKey(m.key)) continue;
        const current = await kvGet({ uid: accountId }, m.key);
        const prev = current ? decodeKvJsonValue(current.value) ?? null : null;
        const next = m.value === null ? null : decodeKvJsonValue(m.value);
        if (!machineConfigWriteRefused(prev, next, new Set())) continue;
        granted ??= await ownerGrantedTools(accountId);
        if (machineConfigWriteRefused(prev, next, granted)) return m.key;
    }
    return null;
}
