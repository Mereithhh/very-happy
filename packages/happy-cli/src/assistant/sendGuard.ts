/**
 * B-924 (QA P1-3): what the main agent may hand to another session in a turn
 * the owner did not type (an automation, `very-happy send`, a Lead, a peer).
 *
 * session_send / session_message / lead_message in such a turn always go to the
 * owner as a gate-2 decision card (whatever the risk and the safety preset),
 * unless the target is in the main agent's own dispatch ledger — the sessions
 * it started itself, which it may nudge. The ledger lands with B-925 (#944);
 * until it is installed the ledger is empty, so every such send asks.
 * In the owner's own turn the gate behaves as before (risk + preset).
 */

import { isOwnerTurn } from './turnOrigin'

export const NON_OWNER_ASK_TOOLS = ['session_send', 'session_message', 'lead_message'] as const

/** `session:<id>` or `team:<id>` (lead_message). */
export type DispatchTarget = string
export type DispatchLedger = (target: DispatchTarget) => boolean

let ledger: DispatchLedger = () => false
/** B-925 installs the main agent's dispatch ledger here; `null` empties it. */
export function installDispatchLedger(next: DispatchLedger | null): void { ledger = next ?? (() => false) }

export function dispatchTarget(toolName: string, args: Record<string, unknown>): DispatchTarget | null {
    const str = (v: unknown) => typeof v === 'string' && v ? v : null
    if (toolName === 'lead_message') { const t = str(args.teamId); return t ? `team:${t}` : null }
    const s = str(args.sessionId) ?? str(args.to)
    return s ? `session:${s}` : null
}

/** Why this call must become a card regardless of risk (gate 2 `mustAsk`), or null. */
export function mainAgentMustAsk(toolName: string, args: Record<string, unknown>, isOwner: () => boolean = isOwnerTurn): string | null {
    if (!(NON_OWNER_ASK_TOOLS as readonly string[]).includes(toolName)) return null
    if (isOwner()) return null
    const target = dispatchTarget(toolName, args)
    if (target && ledger(target)) return null
    return 'not_owner_turn'
}
