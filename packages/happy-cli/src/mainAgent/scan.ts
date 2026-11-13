/**
 * B-924: what the main agent's default automations look at (spec
 * 2026-11-main-agent.md §8). Pure classifiers over injected readers, so the
 * prechecks are testable without a server; `liveScanDeps` wires the real ones.
 *
 *  - stuck:   sessions whose last turn ended on a model API error (B-913
 *             `turnFailure`), or that have been silent for hours in the middle
 *             of a turn with nothing in the background.
 *  - wrap-up: sessions idle for hours that are not the main agent, not a team
 *             bot (Lead or member), not waiting on the owner and without a
 *             wrap-up card yet. Only ever SUGGESTED (a checklist card).
 *  - brief:   one snapshot for the morning brief.
 *
 * Nothing here writes anything: no message, no wrap-up, no card.
 */

import {
    MAIN_AGENT_CARD_KEY, MAIN_AGENT_STUCK_SILENT_HOURS, MAIN_AGENT_WRAPUP_IDLE_HOURS, parseSelectPayload,
    type AttentionItem, type AutomationRun,
} from '@slopus/happy-wire'
import type { LogEntry } from '@/sessions/turnState'
import { analyzeLatestTurn } from '@/sessions/turnState'

const HOUR = 3_600_000

/** The fields of an account session row the scans read (a subset of `AccountSessionSummary`). */
export type ScanSession = {
    id: string
    title?: string
    cwd?: string
    flavor?: string
    variant?: string
    archived: boolean
    active: boolean
    readable: boolean
    updatedAt?: number
    attention: boolean
    backgroundTasks?: { count: number } | null
    turnFailure?: { at: number; summary: string }
}
export type ScanTeam = {
    id: string; name: string; archivedAt?: number
    bots?: Array<{ id: string; name: string; root: boolean; sessionId: string | null }>
    tasks?: Array<{ id: string; goal: string; status: string }>
}

export type ScanDeps = {
    now: () => number
    /** The account's main agent session (KV pointer), excluded from every list. */
    mainAgentSessionId: () => Promise<string | null>
    sessions: () => Promise<ScanSession[]>
    /** The newest messages of a session this machine can read; null when it cannot. */
    recentLog: (sessionId: string, limit: number) => Promise<LogEntry[] | null>
    teams: () => Promise<ScanTeam[]>
    /** Open board items of the account (any session). */
    boardItems: () => Promise<AttentionItem[]>
    /** Automation runs that failed in the last day. */
    failedRuns: () => Promise<AutomationRun[]>
}

export const SCAN_LIMITS = { logReads: 60, logWindow: 60, stuck: 20, wrapup: 20, concurrency: 6 } as const

/** Thresholds in hours; `VH_MAIN_AGENT_STUCK_HOURS` / `VH_MAIN_AGENT_IDLE_HOURS` override them (0.01–168, for test setups). */
export function scanHours(kind: 'stuck' | 'idle', env: NodeJS.ProcessEnv = process.env): number {
    const raw = Number(env[kind === 'stuck' ? 'VH_MAIN_AGENT_STUCK_HOURS' : 'VH_MAIN_AGENT_IDLE_HOURS'])
    if (Number.isFinite(raw) && raw >= 0.01 && raw <= 168) return raw
    return kind === 'stuck' ? MAIN_AGENT_STUCK_SILENT_HOURS : MAIN_AGENT_WRAPUP_IDLE_HOURS
}

export type StuckSession = { sessionId: string; title: string; reason: 'api_error' | 'silent'; detail: string; since: number }
export type WrapupCandidate = { sessionId: string; title: string; idleHours: number; cwd?: string }

const titleOf = (s: ScanSession) => oneLine(s.title || (s.cwd ? s.cwd.split('/').filter(Boolean).pop() ?? s.cwd : s.id), 80)
export function oneLine(text: string, max: number): string {
    const t = text.replace(/\s+/g, ' ').trim()
    return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
const hoursAgo = (at: number, now: number) => Math.max(0, Math.floor((now - at) / HOUR))
const lastAtOf = (log: LogEntry[]) => log.reduce((max, e) => typeof e.createdAt === 'number' && e.createdAt > max ? e.createdAt : max, 0)

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length)
    let next = 0
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]) } }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return out
}

/** Session ids bound to a bot of a live team (Leads and members). */
export function teamSessionIds(teams: readonly ScanTeam[]): Set<string> {
    const ids = new Set<string>()
    for (const team of teams) {
        if (team.archivedAt !== undefined && team.archivedAt !== null) continue
        for (const bot of team.bots ?? []) if (bot.sessionId) ids.add(bot.sessionId)
    }
    return ids
}

/** A user-facing session: not archived, not an assistant / terminal mirror, not the main agent. */
function eligible(s: ScanSession, self: string | null): boolean {
    return !s.archived && s.id !== self && s.variant !== 'assistant' && s.flavor !== 'terminal-mirror'
}

export async function findStuckSessions(deps: ScanDeps): Promise<StuckSession[]> {
    const now = deps.now()
    const [self, sessions] = await Promise.all([deps.mainAgentSessionId(), deps.sessions()])
    const out: StuckSession[] = []
    for (const s of sessions) {
        if (!eligible(s, self) || !s.turnFailure) continue
        out.push({ sessionId: s.id, title: titleOf(s), reason: 'api_error', detail: oneLine(s.turnFailure.summary, 160), since: s.turnFailure.at })
    }
    // Silent: attached, readable, no API error, nothing in the background; its newest turn is open and quiet for hours.
    const silentCandidates = sessions
        .filter(s => eligible(s, self) && !s.turnFailure && s.active && s.readable && !(s.backgroundTasks && s.backgroundTasks.count > 0))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, SCAN_LIMITS.logReads)
    const verdicts = await mapLimited(silentCandidates, SCAN_LIMITS.concurrency, async (s) => {
        const log = await deps.recentLog(s.id, SCAN_LIMITS.logWindow).catch(() => null)
        if (!log?.length) return null
        const turn = analyzeLatestTurn(log)
        const lastAt = lastAtOf(log)
        if (turn.userSeq === null || turn.ended || !lastAt || now - lastAt < scanHours('stuck') * HOUR) return null
        return { sessionId: s.id, title: titleOf(s), reason: 'silent' as const, detail: `no new message for ${hoursAgo(lastAt, now)}h in the middle of a turn`, since: lastAt }
    })
    for (const v of verdicts) if (v) out.push(v)
    return out.sort((a, b) => b.since - a.since).slice(0, SCAN_LIMITS.stuck)
}

/** Sessions already on an open main-agent wrap-up checklist (or with an open wrap-up card of their own). */
function onWrapupCards(items: readonly AttentionItem[]): Set<string> {
    const ids = new Set<string>()
    for (const item of items) {
        if (item.kind === 'wrapup') ids.add(item.sessionId)
        if (item.kind === 'decision' && item.key?.startsWith(MAIN_AGENT_CARD_KEY.wrapup)) {
            for (const entry of parseSelectPayload(item.payload)?.items ?? []) if (entry.ref) ids.add(entry.ref)
        }
    }
    return ids
}

export async function findWrapupCandidates(deps: ScanDeps): Promise<WrapupCandidate[]> {
    const now = deps.now()
    const [self, sessions, teams, items] = await Promise.all([deps.mainAgentSessionId(), deps.sessions(), deps.teams(), deps.boardItems()])
    const bots = teamSessionIds(teams)
    const carded = onWrapupCards(items)
    const pool = sessions
        .filter(s => eligible(s, self) && s.readable && !bots.has(s.id) && !carded.has(s.id) && !s.attention && !s.turnFailure && !(s.backgroundTasks && s.backgroundTasks.count > 0))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, SCAN_LIMITS.logReads)
    const verdicts = await mapLimited(pool, SCAN_LIMITS.concurrency, async (s) => {
        const log = await deps.recentLog(s.id, 5).catch(() => null)
        if (!log?.length) return null
        const lastAt = lastAtOf(log)
        if (!lastAt || now - lastAt < scanHours('idle') * HOUR) return null
        return { sessionId: s.id, title: titleOf(s), idleHours: hoursAgo(lastAt, now), ...(s.cwd ? { cwd: s.cwd } : {}), lastAt }
    })
    return verdicts.filter((v): v is WrapupCandidate & { lastAt: number } => v !== null)
        .sort((a, b) => b.lastAt - a.lastAt)
        .slice(0, SCAN_LIMITS.wrapup)
        .map(({ lastAt: _lastAt, ...v }) => v)
}

export type BriefSnapshot = {
    teams: Array<{ id: string; name: string; open: number; submitted: string[]; boardOpen: number; waitingOwner: number }>
    waitingOwner: Array<{ id: string; title: string; kind: string }>
    stuck: StuckSession[]
    wrapup: WrapupCandidate[]
    failedRuns: Array<{ automation: string; error: string }>
}

export async function briefSnapshot(deps: ScanDeps): Promise<BriefSnapshot> {
    const [teams, items, runs, stuck, wrapup] = await Promise.all([
        deps.teams(), deps.boardItems(), deps.failedRuns().catch(() => [] as AutomationRun[]), findStuckSessions(deps), findWrapupCandidates(deps),
    ])
    const live = teams.filter(t => t.archivedAt === undefined || t.archivedAt === null)
    return {
        teams: live.map(t => {
            const mine = items.filter(i => i.teamId === t.id)
            return {
                id: t.id, name: oneLine(t.name, 60),
                open: (t.tasks ?? []).filter(task => task.status !== 'done' && task.status !== 'cancelled').length,
                submitted: (t.tasks ?? []).filter(task => task.status === 'submitted').map(task => oneLine(task.goal, 80)).slice(0, 5),
                boardOpen: mine.length,
                waitingOwner: mine.filter(i => i.needsOwner).length,
            }
        }),
        waitingOwner: items.filter(i => i.needsOwner).slice(0, 15).map(i => ({ id: i.id, title: oneLine(i.title, 100), kind: i.kind })),
        stuck, wrapup,
        failedRuns: runs.slice(0, 10).map(r => ({ automation: r.automationName, error: oneLine(r.error ?? r.summary ?? 'failed', 100) })),
    }
}

// ─── precheck output (≤ the 4,000 chars the daemon keeps; header first) ──────

export const PRECHECK_TEXT_MAX = 3_800
function clipLines(lines: string[]): string {
    const out: string[] = []
    let size = 0
    for (const line of lines) {
        if (size + line.length + 1 > PRECHECK_TEXT_MAX) { out.push(`… (${lines.length - out.length} more lines left out)`); break }
        out.push(line); size += line.length + 1
    }
    return out.join('\n')
}

export function formatStuck(list: readonly StuckSession[], now: number): string {
    return clipLines([`${list.length} stuck session(s) — sessionId | title | why:`, ...list.map(s =>
        `- ${s.sessionId} | ${s.title} | ${s.reason === 'api_error' ? `API error ${hoursAgo(s.since, now)}h ago: ${s.detail}` : s.detail}`)])
}

export function formatWrapup(list: readonly WrapupCandidate[]): string {
    return clipLines([`${list.length} session(s) idle ≥ ${scanHours('idle')}h that could be wrapped up — sessionId | title | idle:`, ...list.map(c =>
        `- ${c.sessionId} | ${c.title} | idle ${c.idleHours}h${c.cwd ? ` | ${oneLine(c.cwd, 60)}` : ''}`)])
}

export function formatBrief(snapshot: BriefSnapshot, now: number): string {
    const lines: string[] = ['Snapshot for the morning brief:']
    lines.push(`Teams (${snapshot.teams.length}) — name | open tasks | board items (waiting for the owner) | submitted, waiting for acceptance:`)
    for (const t of snapshot.teams) lines.push(`- ${t.name} (${t.id}) | open ${t.open} | board ${t.boardOpen} (${t.waitingOwner}) | ${t.submitted.length ? t.submitted.join(' ; ') : '-'}`)
    lines.push(`Waiting for the owner (${snapshot.waitingOwner.length}):`, ...snapshot.waitingOwner.map(i => `- [${i.kind}] ${i.title} (${i.id})`))
    lines.push(formatStuck(snapshot.stuck, now))
    lines.push(`Failed automation runs, last 24h (${snapshot.failedRuns.length}):`, ...snapshot.failedRuns.map(r => `- ${r.automation}: ${r.error}`))
    lines.push(formatWrapup(snapshot.wrapup))
    return clipLines(lines.flatMap(l => l.split('\n')))
}

/** Order-independent fingerprint of a scan result (what "nothing changed" compares). */
export function fingerprint(keys: readonly string[]): string {
    return [...keys].sort().join('\n')
}
export const stuckKeys = (list: readonly StuckSession[]) => list.map(s => `${s.sessionId}:${s.reason}:${s.since}`)
export const wrapupKeys = (list: readonly WrapupCandidate[]) => list.map(c => c.sessionId)
