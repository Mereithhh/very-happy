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
    if (!value) return null;
    try {
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value));
        return parsed && typeof parsed === 'object' && typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0 && parsed.sessionId.length <= 128 ? parsed.sessionId : null;
    } catch { return null; }
}

export async function isAccountMainAgent(tx: Tx, accountId: string, sessionId: string): Promise<boolean> {
    const row = await tx.userKVStore.findUnique({ where: { accountId_key: { accountId, key: MAIN_AGENT_KV_KEY } }, select: { value: true } });
    if (mainAgentSessionIdOf(row?.value) !== sessionId) return false;
    return !!(await tx.session.findFirst({ where: { id: sessionId, accountId }, select: { id: true } }));
}
