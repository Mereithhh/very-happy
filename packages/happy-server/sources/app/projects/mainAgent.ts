import type { Tx } from '@/storage/inTx';

/**
 * B-916b: the account's main agent (KV `vh.main-agent.v1`, written by its
 * daemon — specs/2026-11-main-agent.md §2.1) is the owner's dispatcher across
 * every project, but a member of none. It may write project notes in its own
 * name in any project of the account; nobody else gains anything: the KV
 * pointer is the account's own, and the session must be one of its sessions.
 * Value: UTF-8 JSON (the client's base64 decoded), unknown fields ignored.
 */
export const MAIN_AGENT_KV_KEY = 'vh.main-agent.v1';

export function mainAgentSessionIdOf(value: Uint8Array | null | undefined): string | null {
    return mainAgentPointerOf(value)?.sessionId ?? null;
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
/** B-924: the pointer's session and (when it names one) machine. */
export function mainAgentPointerOf(value: Uint8Array | null | undefined): { sessionId: string; machineId: string | null } | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value));
        if (!parsed || typeof parsed !== 'object' || !isId(parsed.sessionId)) return null;
        return { sessionId: parsed.sessionId, machineId: isId(parsed.machineId) ? parsed.machineId : null };
    } catch { return null; }
}

/** B-924: the account's main agent session (must be one of its sessions), or null. */
export async function readAccountMainAgent(tx: Tx, accountId: string): Promise<{ sessionId: string; machineId: string | null } | null> {
    const row = await tx.userKVStore.findUnique({ where: { accountId_key: { accountId, key: MAIN_AGENT_KV_KEY } }, select: { value: true } });
    const pointer = mainAgentPointerOf(row?.value);
    if (!pointer) return null;
    return (await tx.session.findFirst({ where: { id: pointer.sessionId, accountId }, select: { id: true } })) ? pointer : null;
}

/** B-924: KV `vh.main-agent-config.v1` (Web settings; base64 UTF-8 JSON on the wire, bytes here), parsed leniently. */
export const MAIN_AGENT_CONFIG_KV_KEY = 'vh.main-agent-config.v1';
/** UTF-8 JSON of a KV value (bytes), or null. */
export function decodeKvJson(value: Uint8Array | null | undefined): unknown {
    if (!value) return null;
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)); } catch { return null; }
}

export async function isAccountMainAgent(tx: Tx, accountId: string, sessionId: string): Promise<boolean> {
    const row = await tx.userKVStore.findUnique({ where: { accountId_key: { accountId, key: MAIN_AGENT_KV_KEY } }, select: { value: true } });
    if (mainAgentSessionIdOf(row?.value) !== sessionId) return false;
    return !!(await tx.session.findFirst({ where: { id: sessionId, accountId }, select: { id: true } }));
}
