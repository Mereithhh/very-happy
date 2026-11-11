/**
 * B-925: the main agent's tool surface for being proactive.
 *
 *  1. follow-up ledger (`withMainAgentProactive`, outside the dispatch gate, so
 *     an approved dispatch is recorded too) — a successful lead_delegate /
 *     session_spawn / session_send / issue_assign is written to
 *     `followups.json`; lead_delegate gets a `[follow-up fu-…]` line at the end
 *     of its goal so the Lead's team task can be found. The ledger is also the
 *     shared send guard's dispatch ledger (`proactiveDispatchLedger`): work the
 *     main agent handed out may be nudged without a card.
 *  2. turn guard (`withTurnGuards`, on the server side of the gate): a
 *     report-only wake uses only `allow` tools.
 *  3. `followups_list`.
 *
 * Owner-only tools and the non-owner decision cards are B-924's shared layers
 * (assistant/turnOrigin.ts, sendGuard.ts, mainAgentToolPolicy.ts).
 */

import { z } from 'zod'
import type { AssistantToolRegistrar } from '../assistantTools'
import { mainAgentToolClass } from '../mainAgentToolPolicy'
import type { DispatchLedger } from '../sendGuard'
import type { TurnOrigin } from '../turnOrigin'
import {
    BASELINE_TASKS_MAX, FOLLOWUP_TITLE_MAX, followupTag, formatFollowupLine, mutateFollowups, newFollowupId, oneLine, readFollowups, readFollowupsSync, sortFollowups,
    type Followup, type FollowupKind,
} from './ledger'

export const FOLLOWUPS_LIST_TOOL = 'followups_list'
export const FOLLOWUP_RECORDED_TOOLS = ['lead_delegate', 'session_spawn', 'session_send', 'issue_assign'] as const

/** The turn in progress: who started it (shared B-924 turn origin) and, for a wake-up, its level. */
export type ProactiveTurn = { origin: TurnOrigin; wake: 'report' | 'follow' | null }

type Result = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
type Handler = (args: any, extra: unknown) => Promise<Result> | Result

export type ProactiveSurfaceDeps = {
    ledgerPath: string
    now?: () => number
    /** Who started the turn in progress, and its wake level. */
    turn: () => ProactiveTurn
    /** How long a follow-up may stay quiet before it is chased (minutes, from the proactive config). */
    followupMinutes: () => number
    /** The proactive level in force (config cache): a turn of unknown origin under `report` is held to report-only. */
    level?: () => 'off' | 'report' | 'follow'
    /** A team's current task ids (lead_delegate baseline, QA P2-2); null when they cannot be read. */
    teamTaskIds?: (teamId: string) => Promise<string[] | null>
    log?: (line: string) => void
}

const text = (r: Result) => r.content.map(c => c.text).join('\n')
const refuse = (body: Record<string, unknown>): Result => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, ...body }) }], isError: true })

/** Pull the facts a ledger entry needs out of a tool's successful receipt. Pure. */
export function followupFromReceipt(name: string, args: Record<string, any>, receipt: string): Omit<Followup, 'id' | 'createdAt' | 'updatedAt' | 'dueAt' | 'state' | 'nudges'> | null {
    const firstLine = (v: unknown) => typeof v === 'string' ? oneLine(v.split('\n').find(l => l.trim()) ?? '', FOLLOWUP_TITLE_MAX) : ''
    if (name === 'lead_delegate') {
        let parsed: any = null
        try { parsed = JSON.parse(receipt) } catch { return null }
        if (parsed?.ok !== true || typeof parsed.leadSessionId !== 'string') return null
        return { kind: 'lead', title: firstLine(args.goal) || 'team work', sessionId: parsed.leadSessionId, teamId: typeof parsed.teamId === 'string' ? parsed.teamId : args.teamId }
    }
    if (name === 'session_spawn') {
        const m = /^Spawned (?:idle session )?([A-Za-z0-9_-]{8,128})/.exec(receipt)
        if (!m || /^Spawned idle session/.test(receipt)) return null // nothing asked yet: nothing to follow
        return { kind: 'spawn', title: firstLine(args.title) || firstLine(args.prompt) || 'new session', sessionId: m[1] }
    }
    if (name === 'session_send') {
        if (!/^Message delivered/.test(receipt) || typeof args.sessionId !== 'string') return null
        return { kind: 'send', title: firstLine(args.text) || 'message', sessionId: args.sessionId }
    }
    if (name === 'issue_assign') {
        const m = /^assigned (VH-\d+)\s+\[[a-z_]+\]\s+(.*?)\s{2}\(/i.exec(receipt)
        if (!m) return null
        return { kind: 'issue', title: oneLine(m[2], FOLLOWUP_TITLE_MAX), issueKey: m[1].toUpperCase(), ...(typeof args.issueId === 'string' ? { issueId: args.issueId } : {}) }
    }
    return null
}

/** New entry; an open spawn / send entry for the same session is superseded (one thread per session). */
export function addFollowup(items: Followup[], entry: Followup): Followup[] {
    const next = items.map(i => i.state === 'open' && entry.sessionId && i.sessionId === entry.sessionId && (i.kind === 'send' || i.kind === 'spawn') && (entry.kind === 'send' || entry.kind === 'spawn')
        ? { ...i, state: 'closed' as const, closedAt: entry.createdAt, updatedAt: entry.createdAt, result: `superseded by ${entry.id}` }
        : i)
    return [...next, entry]
}

export function withMainAgentProactive(mcp: AssistantToolRegistrar, deps: ProactiveSurfaceDeps): AssistantToolRegistrar {
    const now = deps.now ?? Date.now
    const record = async (name: string, args: Record<string, any>, result: Result, id: string, baseline: string[] | null) => {
        if (result.isError) return
        const facts = followupFromReceipt(name, args, text(result))
        if (!facts) return
        const at = now()
        const entry: Followup = { ...facts, id, createdAt: at, updatedAt: at, dueAt: at + deps.followupMinutes() * 60_000, state: 'open', nudges: 0, ...(baseline ? { baselineTaskIds: baseline.slice(0, BASELINE_TASKS_MAX) } : {}) }
        try { await mutateFollowups(deps.ledgerPath, items => addFollowup(items, entry), at) }
        catch (error) { deps.log?.(`[main-agent] follow-up not recorded: ${error instanceof Error ? error.message : String(error)}`) }
    }
    const registerTool = ((name: string, config: any, handler: Handler) => {
        if (!(FOLLOWUP_RECORDED_TOOLS as readonly string[]).includes(name)) return (mcp.registerTool as any)(name, config, handler)
        const recording: Handler = async (args, extra) => {
            const id = newFollowupId()
            const baseline = name === 'lead_delegate' && typeof args?.teamId === 'string' && deps.teamTaskIds
                ? await deps.teamTaskIds(args.teamId).catch(() => null)
                : null
            const callArgs = name === 'lead_delegate' && typeof args?.goal === 'string'
                ? { ...args, goal: `${args.goal.trimEnd()}\n\n${followupTag(id)}` }
                : args
            const result = await handler(callArgs, extra)
            await record(name, args ?? {}, result, id, baseline)
            return result
        }
        return (mcp.registerTool as any)(name, config, recording)
    }) as AssistantToolRegistrar['registerTool']
    return { registerTool }
}

/** The turn guard's verdict for one call (null = let it through). Pure. Owner-only and must-ask are the shared B-924 layers. */
export function turnGuardRefusal(name: string, turn: ProactiveTurn, level: 'off' | 'report' | 'follow' | undefined): Record<string, unknown> | null {
    // A turn with no routed prompt at all is held to report-only when the owner chose it.
    const reportOnly = turn.wake === 'report' || (turn.origin === 'unknown' && turn.wake === null && level === 'report')
    // One source with owner-only and must-ask: anything not `allow` in mainAgentToolPolicy.ts (unknown tools included).
    if (reportOnly && mainAgentToolClass(name) !== 'allow') {
        return { error: 'report_only', note: 'The owner set the main agent to report only: verify and report, do not act on other sessions, teams, issues or automations from a wake-up.' }
    }
    return null
}

/** Targets of the open follow-ups, in the shared ledger-hook format (`session:<id>` / `team:<id>`). Pure. */
export function followedTargets(items: Followup[]): Set<string> {
    const out = new Set<string>()
    for (const i of items) {
        if (i.state !== 'open') continue
        if (i.sessionId) out.add(`session:${i.sessionId}`)
        if (i.kind === 'lead' && i.teamId) out.add(`team:${i.teamId}`)
    }
    return out
}

/**
 * The dispatch ledger B-924's send guard consults (`installDispatchLedger`): a session / team with an open
 * follow-up may be nudged directly in a turn the owner did not type. Everything else asks (a dispatch card
 * bound to the exact target and text; the owner's approval runs it through `dispatch_approved`).
 */
export function proactiveDispatchLedger(ledgerPath: string): DispatchLedger {
    return (target) => followedTargets(readFollowupsSync(ledgerPath)).has(target)
}

/**
 * The B-925 turn guard, registered under the owner-only layer and on the server side of the dispatch gate
 * (QA P2-1: a guard behind the gate never sees a call the gate parks): a report-only wake refuses every tool
 * that is not `allow` in mainAgentToolPolicy.ts (`report_only`). Owner-only tools and the non-owner decision
 * cards are the shared B-924 layers (turnOrigin / sendGuard).
 */
export function withTurnGuards(mcp: AssistantToolRegistrar, deps: Pick<ProactiveSurfaceDeps, 'turn' | 'level'>): AssistantToolRegistrar {
    const registerTool = ((name: string, config: any, handler: Handler) => {
        return (mcp.registerTool as any)(name, config, async (args: any, extra: unknown) => {
            const refusal = turnGuardRefusal(name, deps.turn(), deps.level?.())
            if (refusal) return refuse(refusal)
            return handler(args, extra)
        })
    }) as AssistantToolRegistrar['registerTool']
    return { registerTool }
}

export function registerFollowupsTool(mcp: AssistantToolRegistrar, deps: { ledgerPath: string; now?: () => number }): void {
    const now = deps.now ?? Date.now
    ;(mcp.registerTool as any)(FOLLOWUPS_LIST_TOOL, {
        description: 'List the work you handed out (lead_delegate / session_spawn / session_send / issue_assign) and how far it got: open first. The daemon follows each one: a report when it is done, one nudge when it goes quiet (proactive level follow), a stuck report after that.',
        title: 'List Follow-ups',
        inputSchema: {
            state: z.enum(['open', 'all']).optional().describe('open (default) or all (done / stuck / closed of the last two weeks too)'),
            limit: z.number().int().min(1).max(50).optional(),
        },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false, destructiveHint: false },
    }, async (args: { state?: 'open' | 'all'; limit?: number }) => {
        const all = sortFollowups(await readFollowups(deps.ledgerPath))
        const items = (args?.state === 'all' ? all : all.filter(i => i.state === 'open')).slice(0, args?.limit ?? 30)
        const t = now()
        const open = all.filter(i => i.state === 'open').length
        const body = items.length ? items.map(i => formatFollowupLine(i, t)).join('\n') : (args?.state === 'all' ? 'no follow-ups' : 'no open follow-ups')
        return { content: [{ type: 'text', text: `${open} open of ${all.length} — id state kind age target "title" result:\n${body}` }], isError: false }
    })
}

export type { FollowupKind }
