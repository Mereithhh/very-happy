/**
 * B-925: the daemon side of the proactive main agent (spec 2026-11-main-agent §10).
 *
 * Runs only on the machine the account's main agent lives on (KV pointer).
 * Every minute, and on the session events the daemon already receives, it:
 *
 *  1. reads the proactive settings (KV `vh.main-agent-config.v1`, cached 60 s);
 *  2. polls what may need the owner — open board cards (team acceptances,
 *     request_human left unanswered) and failed automation runs — and turns
 *     the few worth it into wake events (sources.ts, pure);
 *  3. moves the follow-up ledger: turn events, team tasks, issue states, the
 *     clock; a quiet follow-up gets ONE fixed nudge (level follow), then a
 *     stuck report;
 *  4. hands events to the wake engine, which merges and budgets them.
 *
 * Polling and filtering are plain HTTP + code: with nothing worth reporting,
 * no message is sent and the main agent spends no tokens.
 */

import { readMainAgentProactive, type AttentionItem, type AutomationRun, type MainAgentProactiveConfig } from '@slopus/happy-wire'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { applyFollowupSignal, followupNudgeText, followupsPath, mutateFollowups, readFollowups, tickFollowup, type Followup, type FollowupSignal, type FollowupStep } from '@/assistant/proactive/ledger'
import { eventFromFollowup, eventFromSessionExit, eventsFromBoard, eventsFromRuns, type SessionExitInfo } from '@/assistant/proactive/sources'
import { createWakeEngine, type WakeEngine, type WakeEvent } from '@/assistant/proactive/wake'
import { readQuietHours, type QuietHours } from '@/assistant/proactive/quietHours'
import { wakeTokensOn, proactiveUsagePath } from '@/assistant/proactive/usage'
import { writeProactiveConfigCache } from '@/assistant/proactive/configCache'
import { MAIN_AGENT_CONFIG_KV_KEY, decodeKvJson } from '@/assistant/gates/config'
import { MAIN_AGENT_KV_KEY, parseMainAgentPointer, type KvIo } from '@/assistant/mainAgentPointer'

export const PROACTIVE_POLL_MS = 60_000
const CONFIG_TTL_MS = 60_000
const ISSUE_POLLS_MAX = 10
/** How far back the first runs poll after a start looks (older failures were someone else's to report). */
const RUNS_LOOKBACK_MS = 15 * 60_000

type TeamLike = { id: string; tasks?: Array<{ id: string; goal?: string; status: string; ownerBotId?: string | null }>; bots?: Array<{ id: string; sessionId: string | null }> }

export type MainAgentProactiveDeps = {
    home: string
    machineId: string
    kv: KvIo
    now?: () => number
    board: { list: () => Promise<AttentionItem[]>; post: (input: { sessionId: string; key: string; title: string; bodyMd: string }) => Promise<void> }
    failedRuns: () => Promise<AutomationRun[]>
    listTeams: () => Promise<TeamLike[]>
    issue: { status: (ref: string) => Promise<string>; comment: (ref: string, body: string) => Promise<void> }
    /** The live main agent session on this machine, or null. */
    liveMainAgent: () => string | null
    /** Start / re-attach the main agent on this machine; its session id. */
    startMainAgent: () => Promise<string | null>
    /** Wake-up into the main agent. */
    sendWake: (sessionId: string, text: string, localId: string) => Promise<void>
    /** Nudge into a dispatched session / Lead (automated localId). false = not delivered (not running). */
    nudge: (sessionId: string, text: string, localId: string) => Promise<boolean>
    /** The session is in a turn right now (this machine only). */
    busy: (sessionId: string) => boolean
    /** A session's own title (wake PRECHECK title column for follow-ups, QA-T R62 P3-1); null = unknown, left empty. */
    sessionTitle?: (sessionId: string) => string | null
    schedule?: (fn: () => void, ms: number) => { cancel: () => void }
    log?: (line: string) => void
}

export function createMainAgentProactive(deps: MainAgentProactiveDeps) {
    const now = deps.now ?? Date.now
    const log = deps.log ?? (() => {})
    const ledger = followupsPath(deps.home)
    let cached: { at: number; proactive: MainAgentProactiveConfig; quiet: QuietHours; here: boolean; mainSessionId: string | null } | null = null
    let runsSince = now() - RUNS_LOOKBACK_MS
    let timer: ReturnType<typeof setInterval> | null = null
    let ticking = false
    const firstRun = !existsSync(join(deps.home, 'proactive-state.json'))
    let baselined = !firstRun

    async function config() {
        if (cached && now() - cached.at < CONFIG_TTL_MS) return cached
        let raw: unknown = null
        let pointer = null
        try { raw = decodeKvJson((await deps.kv.get(MAIN_AGENT_CONFIG_KV_KEY))?.value) } catch { raw = null }
        try { pointer = parseMainAgentPointer((await deps.kv.get(MAIN_AGENT_KV_KEY))?.value) } catch { pointer = null }
        const proactive = readMainAgentProactive(raw)
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        // No pointer (old server / never set) = the main agent of this machine, if any.
        const here = pointer ? pointer.machineId === deps.machineId : true
        cached = { at: now(), proactive, quiet: readQuietHours(raw, tz), here, mainSessionId: pointer?.sessionId ?? null }
        void writeProactiveConfigCache(deps.home, proactive).catch(() => {})
        return cached
    }

    const engine: WakeEngine = createWakeEngine({
        now,
        statePath: join(deps.home, 'proactive-state.json'),
        config: async () => { const c = await config(); return { proactive: c.proactive, quiet: c.quiet } },
        mainAgent: async () => {
            const c = await config()
            if (!c.here) return null
            const live = deps.liveMainAgent()
            if (live) return { sessionId: live }
            const started = await deps.startMainAgent()
            return started ? { sessionId: started } : null
        },
        send: deps.sendWake,
        postBoard: deps.board.post,
        tokensOn: (day, tz) => wakeTokensOn(proactiveUsagePath(deps.home), day, tz, now()),
        ...(deps.schedule ? { schedule: deps.schedule } : {}),
        log,
    })

    function mainId(): string | null {
        return deps.liveMainAgent() ?? cached?.mainSessionId ?? null
    }

    async function offer(events: WakeEvent[]): Promise<void> {
        if (!events.length) return
        const c = await config()
        if (!c.here) return
        await engine.offer(events)
    }

    /** Apply steps to the ledger; returns the events and nudges to act on. */
    async function step(fn: (item: Followup) => FollowupStep): Promise<{ events: WakeEvent[]; nudges: Followup[] }> {
        const events: WakeEvent[] = []
        const nudges: Followup[] = []
        if (!existsSync(ledger)) return { events, nudges }
        await mutateFollowups(ledger, items => items.map(item => {
            const s = fn(item)
            if (s.event) events.push(eventFromFollowup(s.event, s.item, now(), s.item.kind !== 'issue' && s.item.sessionId ? deps.sessionTitle?.(s.item.sessionId) : null))
            if (s.nudge) nudges.push(s.item)
            return s.item
        }), now())
        return { events, nudges }
    }

    async function signal(sig: FollowupSignal): Promise<void> {
        try {
            const c = await config()
            const { events } = await step(item => applyFollowupSignal(item, sig, c.proactive.followupMinutes * 60_000))
            await offer(events)
        } catch (error) { log(`[main-agent proactive] signal failed: ${error instanceof Error ? error.message : String(error)}`) }
    }

    async function sendNudge(item: Followup): Promise<boolean> {
        const localId = `automation-followup-${item.id}-${item.nudges}`
        try {
            if (item.kind === 'issue') {
                const ref = item.issueId ?? item.issueKey
                if (!ref) return false
                await deps.issue.comment(ref, followupNudgeText(item))
                return true
            }
            if (!item.sessionId) return false
            return await deps.nudge(item.sessionId, followupNudgeText(item), localId)
        } catch (error) {
            log(`[main-agent proactive] nudge ${item.id} failed: ${error instanceof Error ? error.message : String(error)}`)
            return false
        }
    }

    async function pollFollowups(c: Awaited<ReturnType<typeof config>>): Promise<WakeEvent[]> {
        const open = (await readFollowups(ledger)).filter(i => i.state === 'open')
        if (!open.length) return []
        const windowMs = c.proactive.followupMinutes * 60_000
        const out: WakeEvent[] = []
        // Team tasks for Lead follow-ups (one list call).
        if (open.some(i => i.kind === 'lead')) {
            try {
                const teams = await deps.listTeams()
                for (const team of teams) {
                    if (!open.some(i => i.kind === 'lead' && i.teamId === team.id)) continue
                    const tasks = (team.tasks ?? []).map(t => ({ id: t.id, goal: t.goal ?? '', status: t.status, ownerBotId: t.ownerBotId ?? null }))
                    const bots = (team.bots ?? []).map(b => ({ id: b.id, sessionId: b.sessionId ?? null }))
                    out.push(...(await step(item => applyFollowupSignal(item, { type: 'team_tasks', teamId: team.id, tasks, bots, at: now() }, windowMs))).events)
                }
            } catch (error) { log(`[main-agent proactive] teams poll failed: ${error instanceof Error ? error.message : String(error)}`) }
        }
        for (const item of open.filter(i => i.kind === 'issue').slice(0, ISSUE_POLLS_MAX)) {
            const ref = item.issueId ?? item.issueKey
            if (!ref) continue
            try {
                const status = await deps.issue.status(ref)
                out.push(...(await step(i => i.id === item.id ? applyFollowupSignal(i, { type: 'issue', issueId: i.issueId ?? ref, status, at: now() }, windowMs) : { item: i })).events)
            } catch { /* next minute */ }
        }
        // The clock: nudge once, then stuck.
        const ticked = await step(item => tickFollowup(item, now(), { level: c.proactive.level, windowMs, busy: item.sessionId ? deps.busy(item.sessionId) : false }))
        out.push(...ticked.events)
        for (const item of ticked.nudges) {
            if (await sendNudge(item)) continue
            // Not running any more: nobody to nudge — report it instead of waiting another window.
            out.push(...(await step(i => i.id === item.id && i.state === 'open'
                ? { item: { ...i, state: 'stuck', closedAt: now(), updatedAt: now(), result: 'not running; nudge not delivered' }, event: 'followup_stuck' }
                : { item: i })).events)
        }
        return out
    }

    async function tick(): Promise<void> {
        if (ticking) return
        ticking = true
        try {
            const c = await config()
            if (!c.here) return
            const t = now()
            const events: WakeEvent[] = []
            const main = mainId()
            try { events.push(...eventsFromBoard(await deps.board.list(), { mainAgentSessionId: main, now: t, requestHumanMs: c.proactive.requestHumanMinutes * 60_000 })) }
            catch { /* old server: no board */ }
            try { events.push(...eventsFromRuns(await deps.failedRuns(), { since: runsSince, now: t })) }
            catch { /* old server */ }
            runsSince = t - PROACTIVE_POLL_MS
            if (!baselined) {
                // First start: what is already open was there before the owner turned this on — remember, don't wake.
                await engine.remember(events)
                baselined = true
                events.length = 0
            }
            events.push(...await pollFollowups(c))
            await offer(events)
        } catch (error) {
            log(`[main-agent proactive] tick failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally { ticking = false }
    }

    return {
        start(): void {
            if (timer) return
            timer = setInterval(() => void tick(), PROACTIVE_POLL_MS)
            timer.unref?.()
            void tick()
        },
        stop(): void { if (timer) clearInterval(timer); timer = null; engine.stop() },
        tick,
        /** Session turn / state events from the control server (any session on this machine). */
        onTurnEvent(sessionId: string, event: 'turn_started' | 'turn_ended'): void {
            if (sessionId === deps.liveMainAgent()) return
            void signal({ type: event, sessionId, at: now() })
        },
        onNeedsInput(sessionId: string): void { void signal({ type: 'needs_input', sessionId, at: now() }) },
        onSessionExit(info: SessionExitInfo): void {
            const event = eventFromSessionExit(info, now())
            void signal({ type: 'session_exit', sessionId: info.sessionId, at: now(), error: event !== null })
            if (event) void offer([event])
        },
        /** True once the settings were read and this is the main agent's machine (B-069 reports step aside). */
        active: () => cached?.here === true,
        engine,
        ledgerPath: ledger,
    }
}
export type MainAgentProactive = ReturnType<typeof createMainAgentProactive>
