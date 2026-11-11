/**
 * B-924: the main agent's second batch of tools (spec 2026-11-main-agent.md §3.2):
 *
 *  - boards_read      read-only: the open items of every team's Lead board (and the rest of the account's board), capped.
 *  - sessions_search  read-only: the account's sessions by project / state / text, capped.
 *  - wrapup_suggest   post ONE checklist decision card of sessions that could be wrapped up. Wraps nothing up.
 *  - wrapup_selected  after the owner chose 收尾所选 on such a card: wrap up exactly the ticked sessions.
 *
 * The only way from a suggestion to a wrap-up is the owner: wrapup_selected
 * acts on a card of THIS session, under the wrap-up key, resolved by the owner
 * with the approve option — and then only on the entries the owner ticked.
 * Anything else answers a refusal and calls nothing.
 */

import { z } from 'zod'
import {
    ATTENTION_SELECT_LIMITS, MAIN_AGENT_CARD_KEY, parseSelectPayload,
    type AttentionItem, type AttentionItemListQuery, type AttentionItemPost, type AttentionItemResolve, type TurnFailure,
} from '@slopus/happy-wire'
import type { AssistantToolRegistrar } from './assistantTools'
import { isValidSessionId } from './ids'
import type { WrapupReceipt } from './mainAgentTools'

export const MAIN_AGENT_OPS_TOOL_NAMES = ['boards_read', 'sessions_search', 'wrapup_suggest', 'wrapup_selected'] as const

/** Option ids of the wrap-up checklist card. */
export const WRAPUP_APPROVE_OPTION = 'wrapup'
export const WRAPUP_SKIP_OPTION = 'skip'

export const BOARDS_READ_LIMITS = { perTeam: 10, perTeamMax: 25, items: 200 } as const
export const SESSIONS_SEARCH_LIMITS = { default: 20, max: 50 } as const

export type SearchSession = {
    id: string; title?: string; cwd?: string; flavor?: string; variant?: string; machineId?: string
    archived: boolean; active: boolean; attention: boolean; readable: boolean; updatedAt?: number; turnFailure?: TurnFailure
}
type TeamLike = { id: string; name: string; archivedAt?: number; bots?: Array<{ id: string; name: string; root: boolean; sessionId: string | null }> }

export type MainAgentOpsDeps = {
    sessionId: () => string
    now?: () => number
    board: {
        list: (query: AttentionItemListQuery) => Promise<{ items: AttentionItem[] }>
        post: (input: AttentionItemPost) => Promise<{ item: AttentionItem; created: boolean }>
        resolve: (id: string, input: AttentionItemResolve) => Promise<{ item: AttentionItem }>
    }
    listTeams: () => Promise<TeamLike[]>
    /** The account's sessions (decrypted where this machine can). */
    sessions: (options: { includeArchived: boolean }) => Promise<SearchSession[]>
    /** Session ids of a project (its members). */
    projectSessionIds: (projectId: string) => Promise<string[]>
    /** B-919 wrap-up backend; absent = not available on this version. */
    wrapup: () => ((input: { sessionId: string; requestId: string }) => Promise<WrapupReceipt>) | undefined
}

type Result = { content: Array<{ type: 'text'; text: string }>; isError: boolean }
const ok = (text: string): Result => ({ content: [{ type: 'text', text }], isError: false })
const fail = (text: string): Result => ({ content: [{ type: 'text', text }], isError: true })
const oneLine = (text: string, max: number) => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t }
const age = (at: number, now: number) => { const m = Math.max(0, Math.round((now - at) / 60_000)); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d` }
const id = z.string().min(1).max(128)

export const SESSION_SEARCH_STATES = ['active', 'inactive', 'api_error', 'needs_owner', 'archived'] as const

export function sessionMatches(s: SearchSession, filter: { state?: typeof SESSION_SEARCH_STATES[number]; q?: string; flavor?: string }): boolean {
    if (filter.state === 'archived' ? !s.archived : s.archived) return false
    if (filter.state === 'active' && !s.active) return false
    if (filter.state === 'inactive' && s.active) return false
    if (filter.state === 'api_error' && !s.turnFailure) return false
    if (filter.state === 'needs_owner' && !s.attention) return false
    if (filter.flavor && s.flavor !== filter.flavor) return false
    if (filter.q) {
        const q = filter.q.toLowerCase()
        if (![s.id, s.title, s.cwd].some(v => typeof v === 'string' && v.toLowerCase().includes(q))) return false
    }
    return true
}

/**
 * Why `wrapup_selected` refuses this card, or null when it may act. Pure, so
 * every refusal path is unit-tested: nothing is wrapped up unless all hold.
 */
export function wrapupCardRefusal(item: AttentionItem | undefined, selfSessionId: string): string | null {
    if (!item) return 'card_not_found'
    if (item.sessionId !== selfSessionId) return 'not_my_card'
    if (item.kind !== 'decision' || !item.key?.startsWith(MAIN_AGENT_CARD_KEY.wrapup)) return 'not_a_wrapup_card'
    if (!parseSelectPayload(item.payload)) return 'not_a_checklist'
    if (item.state !== 'resolved' || item.resolvedBy !== 'owner') return 'owner_has_not_chosen'
    if (item.ownerChoice !== WRAPUP_APPROVE_OPTION) return 'owner_chose_not_to'
    return null
}

/** The sessions the owner ticked on the card (valid session ids only). */
export function tickedSessions(item: AttentionItem): string[] {
    return (parseSelectPayload(item.payload)?.items ?? []).filter(i => i.checked && typeof i.ref === 'string' && isValidSessionId(i.ref)).map(i => i.ref!)
}

export function registerMainAgentOpsTools(mcp: AssistantToolRegistrar, deps: MainAgentOpsDeps): void {
    const now = deps.now ?? Date.now
    const register = (name: typeof MAIN_AGENT_OPS_TOOL_NAMES[number], description: string, inputSchema: Record<string, z.ZodTypeAny>, readOnly: boolean, run: (args: any) => Promise<Result>) => {
        mcp.registerTool(name, {
            description, inputSchema,
            annotations: { readOnlyHint: readOnly, idempotentHint: readOnly, openWorldHint: false, destructiveHint: false },
        }, async (args: any) => {
            try { return await run(args ?? {}) }
            catch (error) { return fail(oneLine(error instanceof Error ? error.message : String(error), 300)) }
        })
    }

    // ── boards_read ──────────────────────────────────────────────────────────
    register('boards_read', `Read the open items of each team's board (what its Lead posted for the owner), read-only: one block per team, newest first, at most ${BOARDS_READ_LIMITS.perTeam} items per team by default. teamId = one team only. Items outside any team come last ("other").`, {
        teamId: id.optional().describe('From teams_list'),
        perTeam: z.number().int().min(1).max(BOARDS_READ_LIMITS.perTeamMax).optional().describe(`Items per team (default ${BOARDS_READ_LIMITS.perTeam})`),
        needsOwner: z.boolean().optional().describe('Only items waiting on the owner'),
    }, true, async (args) => {
        const [teams, { items }] = await Promise.all([deps.listTeams(), deps.board.list({ state: 'open', limit: BOARDS_READ_LIMITS.items, ...(args.needsOwner ? { needsOwner: 'true' } : {}) })])
        const live = teams.filter(t => t.archivedAt === undefined || t.archivedAt === null).filter(t => !args.teamId || t.id === args.teamId)
        if (args.teamId && !live.length) return fail(`Team ${args.teamId} not found (teams_list shows the account's teams).`)
        const per = args.perTeam ?? BOARDS_READ_LIMITS.perTeam
        const t = now()
        const line = (i: AttentionItem) => `- [${i.kind}${i.needsOwner ? '·owner' : ''}] ${oneLine(i.title, 90)} (${i.id}) ${age(i.updatedAt, t)}`
        const blocks: string[] = []
        for (const team of live) {
            const mine = items.filter(i => i.teamId === team.id)
            const lead = (team.bots ?? []).find(b => b.root && b.sessionId)
            blocks.push(`## ${oneLine(team.name, 50)} (${team.id})${lead ? ` lead=${lead.name}` : ''}: ${mine.length} open${mine.length > per ? `, newest ${per}` : ''}`, ...mine.slice(0, per).map(line))
        }
        if (!args.teamId) {
            // Items of archived / unknown teams count as "other".
            const teamIds = new Set(live.map(x => x.id))
            const other = items.filter(i => !i.teamId || !teamIds.has(i.teamId))
            if (other.length) blocks.push(`## other: ${other.length} open${other.length > per ? `, newest ${per}` : ''}`, ...other.slice(0, per).map(line))
        }
        return ok(blocks.length ? blocks.join('\n') : 'no open board items')
    })

    // ── sessions_search ──────────────────────────────────────────────────────
    register('sessions_search', `Search the account's sessions (every machine): by project, state (active | inactive | api_error = last turn stopped on a model API error | needs_owner = waiting on a permission / question | archived), agent flavor, or text in title / directory / id. Newest first, default ${SESSIONS_SEARCH_LIMITS.default}, max ${SESSIONS_SEARCH_LIMITS.max}. Sessions of machines whose keys this one lacks show without title.`, {
        projectId: id.optional().describe('From project_list'),
        state: z.enum(SESSION_SEARCH_STATES).optional(),
        flavor: z.string().min(1).max(32).optional().describe('claude | codex | pi | …'),
        q: z.string().min(1).max(200).optional().describe('Text in title, directory or id'),
        limit: z.number().int().min(1).max(SESSIONS_SEARCH_LIMITS.max).optional(),
    }, true, async (args) => {
        const [sessions, members] = await Promise.all([
            deps.sessions({ includeArchived: args.state === 'archived' }),
            args.projectId ? deps.projectSessionIds(args.projectId).then(ids => new Set(ids)) : Promise.resolve(null),
        ])
        const self = deps.sessionId()
        const hits = sessions
            .filter(s => s.id !== self && (!members || members.has(s.id)) && sessionMatches(s, args))
            .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        const limit = args.limit ?? SESSIONS_SEARCH_LIMITS.default
        if (!hits.length) return ok('no matching sessions')
        const t = now()
        return ok([`${hits.length} session(s)${hits.length > limit ? `, newest ${limit}` : ''} — id [state] title | agent | directory:`, ...hits.slice(0, limit).map(s => {
            const flags = [s.active ? 'active' : 'inactive', s.archived ? 'archived' : '', s.turnFailure ? 'api-error' : '', s.attention ? 'needs-owner' : ''].filter(Boolean).join(',')
            return `${s.id} [${flags}] ${s.readable ? `"${oneLine(s.title ?? '(untitled)', 60)}"` : '(other machine)'}${s.flavor ? ` | ${s.flavor}` : ''}${s.cwd ? ` | ${oneLine(s.cwd, 50)}` : ''}${s.updatedAt ? ` | ${age(s.updatedAt, t)}` : ''}`
        })].join('\n'))
    })

    // ── wrapup_suggest ───────────────────────────────────────────────────────
    register('wrapup_suggest', `Suggest sessions to wrap up: posts ONE checklist decision card (options 收尾所选 / 这次不用) listing them with your one-line reason each, nothing ticked. It wraps up nothing — the owner ticks the ones to wrap up and chooses 收尾所选; you then get a message and call wrapup_selected. Up to ${ATTENTION_SELECT_LIMITS.items} sessions; an earlier open suggestion card is closed as superseded.`, {
        sessions: z.array(z.object({
            sessionId: id,
            title: z.string().min(1).max(ATTENTION_SELECT_LIMITS.labelChars).optional().describe('Shown on the card (default: the session id)'),
            reason: z.string().min(1).max(ATTENTION_SELECT_LIMITS.detailChars).describe('One line: why it looks done'),
        })).min(1).max(ATTENTION_SELECT_LIMITS.items),
        requestId: z.string().min(1).max(64).optional().describe('Reuse it with the same arguments after an uncertain answer'),
    }, false, async (args) => {
        const self = deps.sessionId()
        const seen = new Set<string>()
        const entries = (args.sessions as Array<{ sessionId: string; title?: string; reason: string }>).filter(s => {
            if (!isValidSessionId(s.sessionId) || s.sessionId === self || seen.has(s.sessionId)) return false
            seen.add(s.sessionId); return true
        })
        if (!entries.length) return fail('No valid session ids (the main agent itself is never suggested).')
        const key = `${MAIN_AGENT_CARD_KEY.wrapup}${args.requestId ?? new Date(now()).toISOString().slice(0, 16)}`
        const { items: open } = await deps.board.list({ sessionId: self, state: 'open', limit: 50 })
        const { item, created } = await deps.board.post({
            sessionId: self, source: 'agent', kind: 'decision', key, requestId: key,
            title: `可以收尾的会话（${entries.length} 个）`,
            bodyMd: '勾选要收尾的会话，再点「收尾所选」。没勾选的不会动；收尾只是让会话写收尾总结，不会关闭或归档。',
            options: [{ id: WRAPUP_APPROVE_OPTION, label: '收尾所选', recommended: true }, { id: WRAPUP_SKIP_OPTION, label: '这次不用' }],
            payload: { v: 1, type: 'select', items: entries.map((s, i) => ({ id: `s${i + 1}`, label: oneLine(s.title ?? s.sessionId, ATTENTION_SELECT_LIMITS.labelChars), detail: oneLine(s.reason, ATTENTION_SELECT_LIMITS.detailChars), ref: s.sessionId, checked: false })) },
            inferred: false,
        })
        let superseded = 0
        for (const old of open) {
            if (old.id === item.id || old.kind !== 'decision' || !old.key?.startsWith(MAIN_AGENT_CARD_KEY.wrapup)) continue
            await deps.board.resolve(old.id, { outcome: 'superseded', note: 'replaced by a newer suggestion' }).then(() => { superseded++ }, () => undefined)
        }
        return ok(JSON.stringify({ ok: true, boardItemId: item.id, created, state: 'awaiting_owner', note: `${entries.length} session(s) listed, none ticked${superseded ? `; ${superseded} older card(s) superseded` : ''}` }))
    })

    // ── wrapup_selected ──────────────────────────────────────────────────────
    register('wrapup_selected', 'After the owner chose 收尾所选 on your wrap-up checklist card: wrap up exactly the sessions they ticked (each gets one wrap-up turn, the same as the owner pressing 收尾; nothing is closed or archived). Refuses unless the owner made that choice on that card; sessions not ticked are never touched.', {
        boardItemId: id.describe('The card id (in the owner\'s message)'),
    }, false, async (args) => {
        const self = deps.sessionId()
        const { items } = await deps.board.list({ sessionId: self, state: 'all', limit: 200 })
        const item = items.find(i => i.id === args.boardItemId)
        const refusal = wrapupCardRefusal(item, self)
        if (refusal) return fail(JSON.stringify({ ok: false, error: refusal, boardItemId: args.boardItemId }))
        const wrapup = deps.wrapup()
        if (!wrapup) return fail(JSON.stringify({ ok: false, error: 'not_available', note: 'Wrap-up is not available on this Very Happy version yet' }))
        const ticked = tickedSessions(item!)
        const total = parseSelectPayload(item!.payload)?.items.length ?? 0
        if (!ticked.length) return ok(JSON.stringify({ ok: true, boardItemId: item!.id, queued: 0, note: 'the owner ticked none: nothing wrapped up' }))
        const results: string[] = []
        let queued = 0
        for (const sessionId of ticked) {
            try {
                // One request id per (card, session): a retried call does not ask twice.
                const r = await wrapup({ sessionId, requestId: `${item!.id}:${sessionId}` })
                if (r.ok) { queued++; results.push(`${sessionId.slice(0, 10)} ${r.state}`) } else results.push(`${sessionId.slice(0, 10)} ${oneLine(r.error, 40)}`)
            } catch (error) {
                results.push(`${sessionId.slice(0, 10)} failed: ${oneLine(error instanceof Error ? error.message : String(error), 40)}`)
            }
        }
        return ok(JSON.stringify({ ok: true, boardItemId: item!.id, queued, note: `${ticked.length} of ${total} ticked; ${results.join('; ')}` }))
    })
}
