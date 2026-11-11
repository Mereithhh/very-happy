/**
 * B-924 (QA P1-3) / B-924b: what the main agent may hand to another executor in
 * a turn the owner did not type (an automation, `very-happy send`, a Lead, a
 * peer, a wake-up).
 *
 * Every class-② tool of mainAgentToolPolicy.ts (sends into sessions, terminals,
 * teams and issue runs, and everything that creates, changes, starts or stops an
 * automation) always goes to the owner as a gate-2 decision card in such a turn,
 * whatever the risk and the safety preset. Exception: a direct send whose target
 * is in the main agent's dispatch ledger — the sessions / teams it started
 * itself, which it may nudge. Automations, issues, spawns and team tools never
 * use the ledger. The ledger lands with B-925 (#944); until it is installed it
 * is empty, so every such call asks.
 * In the owner's own turn the gate behaves as before (risk + preset).
 */

import { isOwnerTurn } from './turnOrigin'
import { MAIN_AGENT_ASK_TOOLS } from './mainAgentToolPolicy'

/** Class ② of mainAgentToolPolicy.ts. */
export const NON_OWNER_ASK_TOOLS: readonly string[] = MAIN_AGENT_ASK_TOOLS
const AUTOMATION_TOOLS = new Set(['automation_create', 'automation_update', 'automation_run', 'automation_fire', 'automation_resume', 'automation_pause', 'automation_delete'])

/** `session:<id>`, `team:<id>` (lead_*) or `terminal:<id>`. */
export type DispatchTarget = string
export type DispatchLedger = (target: DispatchTarget) => boolean

let ledger: DispatchLedger = () => false
/** B-925 installs the main agent's dispatch ledger here; `null` empties it. */
export function installDispatchLedger(next: DispatchLedger | null): void { ledger = next ?? (() => false) }

/** The ledger key of a direct send; null for every tool that cannot be exempted by the ledger. */
export function dispatchTarget(toolName: string, args: Record<string, unknown>): DispatchTarget | null {
    const str = (v: unknown) => typeof v === 'string' && v ? v : null
    switch (toolName) {
        case 'lead_message': case 'lead_delegate': { const t = str(args.teamId); return t ? `team:${t}` : null }
        case 'session_send': { const s = str(args.sessionId); return s ? `session:${s}` : null }
        case 'session_message': { const s = str(args.to) ?? str(args.sessionId); return s ? `session:${s}` : null }
        case 'terminal_send': { const t = str(args.terminalId); return t ? `terminal:${t}` : null }
        default: return null
    }
}

export type MustAskReason = 'not_owner_turn' | 'not_owner_turn_automation'

/** Why this call must become a card regardless of risk (gate 2 `mustAsk`), or null. */
export function mainAgentMustAsk(toolName: string, args: Record<string, unknown>, isOwner: () => boolean = isOwnerTurn): MustAskReason | null {
    if (!NON_OWNER_ASK_TOOLS.includes(toolName)) return null
    if (isOwner()) return null
    if (AUTOMATION_TOOLS.has(toolName)) return 'not_owner_turn_automation'
    const target = dispatchTarget(toolName, args)
    if (target && ledger(target)) return null
    return 'not_owner_turn'
}

/** The card's 原因 line for a reason. */
export function mustAskReasonLine(reason: MustAskReason): string {
    return reason === 'not_owner_turn_automation'
        ? '原因：这一回合不是你本人发起的（自动化、脚本或别的会话发来的消息）。这种回合里主 agent 不能新建、修改、启动、暂停或删除自动化（自动化会把文字送进别的会话），所以先问你。'
        : '原因：这一回合不是你本人发起的（自动化、脚本或别的会话发来的消息），主 agent 给别的会话、终端、团队或 issue 发内容都先问你。'
}
