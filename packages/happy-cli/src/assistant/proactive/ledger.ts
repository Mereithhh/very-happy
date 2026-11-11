/**
 * B-925 follow-up ledger: every piece of work the main agent hands out
 * (lead_delegate / session_spawn / session_send / issue_assign) is written
 * here and followed until it is done.
 *
 * Storage: `~/.happy/assistant/followups.json` (0600). Two processes write it —
 * the main agent's wrapper records new entries, the daemon moves their state —
 * so every write is read-modify-rename under an `O_EXCL` lock file. Survives
 * restarts of either process.
 *
 * The transitions below are pure: the daemon feeds them what it saw (turn
 * events, team tasks, issue states, the clock) and acts on what they return
 * (a fixed nudge, a wake-up event). Nothing here wraps up, archives or stops
 * a session.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { MainAgentProactiveLevel } from '@slopus/happy-wire'

export const FOLLOWUP_KINDS = ['lead', 'spawn', 'send', 'issue'] as const
export type FollowupKind = typeof FOLLOWUP_KINDS[number]
export const FOLLOWUP_STATES = ['open', 'done', 'stuck', 'closed'] as const
export type FollowupState = typeof FOLLOWUP_STATES[number]

export type Followup = {
    id: string
    kind: FollowupKind
    /** One line: what was asked (≤120 chars). */
    title: string
    createdAt: number
    updatedAt: number
    /** When it is chased (open, never nudged) or reported stuck (open, nudged once). */
    dueAt: number
    state: FollowupState
    /** spawn / send: the session doing it; lead: the Lead's session. */
    sessionId?: string
    teamId?: string
    issueId?: string
    issueKey?: string
    nudges: number
    lastActivityAt?: number
    /** Set once a spawned session asked for input (reported once). */
    blockedAt?: number
    /** lead: the team's task ids when the work was handed over — a newer task the Lead owns is its delegation, tag or not. */
    baselineTaskIds?: string[]
    /** lead, report level: already given one extra window because the Lead was active (see tickFollowup). */
    extended?: boolean
    /** One line on how it ended (≤200 chars). */
    result?: string
    closedAt?: number
}

export const FOLLOWUP_TITLE_MAX = 120
export const FOLLOWUP_RESULT_MAX = 200
export const FOLLOWUPS_MAX = 300
export const BASELINE_TASKS_MAX = 1000
const CLOSED_KEEP_MS = 14 * 24 * 60 * 60_000
const LOCK_STALE_MS = 10_000
const LOCK_TRIES = 150
const LOCK_WAIT_MS = 20

/** Tag the Lead is asked to keep in the team task it creates, so the daemon can find that task. */
export function followupTag(id: string): string {
    return `[follow-up ${id}]`
}

export function newFollowupId(): string {
    return `fu-${randomBytes(4).toString('hex')}`
}

export function oneLine(text: string, max: number): string {
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function followupsPath(home: string): string {
    return join(home, 'followups.json')
}

// ─── storage ────────────────────────────────────────────────────────────────

const isStr = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function parseItem(raw: unknown): Followup | null {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    if (!isStr(r.id, 64) || !(FOLLOWUP_KINDS as readonly unknown[]).includes(r.kind) || !(FOLLOWUP_STATES as readonly unknown[]).includes(r.state)) return null
    if (!isNum(r.createdAt) || !isNum(r.dueAt)) return null
    return {
        id: r.id, kind: r.kind as FollowupKind, state: r.state as FollowupState,
        title: typeof r.title === 'string' ? oneLine(r.title, FOLLOWUP_TITLE_MAX) : '',
        createdAt: r.createdAt, updatedAt: isNum(r.updatedAt) ? r.updatedAt : r.createdAt, dueAt: r.dueAt,
        nudges: isNum(r.nudges) ? r.nudges : 0,
        ...(isStr(r.sessionId, 128) ? { sessionId: r.sessionId } : {}),
        ...(isStr(r.teamId, 128) ? { teamId: r.teamId } : {}),
        ...(isStr(r.issueId, 128) ? { issueId: r.issueId } : {}),
        ...(isStr(r.issueKey, 32) ? { issueKey: r.issueKey } : {}),
        ...(isNum(r.lastActivityAt) ? { lastActivityAt: r.lastActivityAt } : {}),
        ...(isNum(r.blockedAt) ? { blockedAt: r.blockedAt } : {}),
        ...(r.extended === true ? { extended: true } : {}),
        ...(Array.isArray(r.baselineTaskIds) ? { baselineTaskIds: (r.baselineTaskIds as unknown[]).filter((x): x is string => isStr(x, 128)).slice(0, BASELINE_TASKS_MAX) } : {}),
        ...(typeof r.result === 'string' ? { result: oneLine(r.result, FOLLOWUP_RESULT_MAX) } : {}),
        ...(isNum(r.closedAt) ? { closedAt: r.closedAt } : {}),
    }
}

export function parseFollowups(text: string): Followup[] {
    try {
        const raw = JSON.parse(text)
        const items = Array.isArray(raw?.items) ? raw.items : []
        return items.map(parseItem).filter((x: Followup | null): x is Followup => x !== null)
    } catch { return [] }
}

export async function readFollowups(path: string): Promise<Followup[]> {
    try { return parseFollowups(await readFile(path, 'utf8')) } catch { return [] }
}

/** Sync read for the gate's dispatch-ledger hook (a small 0600 file on local disk). */
export function readFollowupsSync(path: string): Followup[] {
    try { return parseFollowups(readFileSync(path, 'utf8')) } catch { return [] }
}

/** Keep every open entry; drop closed ones past two weeks, then the oldest closed ones beyond the cap. */
export function pruneFollowups(items: Followup[], now: number): Followup[] {
    const kept = items.filter(i => i.state === 'open' || now - (i.closedAt ?? i.updatedAt) < CLOSED_KEEP_MS)
    if (kept.length <= FOLLOWUPS_MAX) return kept
    const closed = kept.filter(i => i.state !== 'open').sort((a, b) => (a.closedAt ?? a.updatedAt) - (b.closedAt ?? b.updatedAt))
    const drop = new Set(closed.slice(0, kept.length - FOLLOWUPS_MAX).map(i => i.id))
    return kept.filter(i => !drop.has(i.id))
}

export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const lock = `${path}.lock`
    await mkdir(dirname(path), { recursive: true })
    for (let i = 0; i < LOCK_TRIES; i++) {
        try {
            const fh = await open(lock, 'wx', 0o600)
            await fh.close()
            try { return await fn() } finally { await unlink(lock).catch(() => {}) }
        } catch (error: any) {
            if (error?.code !== 'EEXIST') throw error
            try { if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) await unlink(lock).catch(() => {}) } catch { /* gone */ }
            await new Promise(r => setTimeout(r, LOCK_WAIT_MS))
        }
    }
    throw new Error('followups ledger is locked')
}

/** Read, change and write the ledger under its lock. `fn` returns the new list (or nothing to keep it). */
export async function mutateFollowups(path: string, fn: (items: Followup[]) => Followup[] | void, now = Date.now()): Promise<Followup[]> {
    return withFileLock(path, async () => {
        const current = existsSync(path) ? await readFollowups(path) : []
        const next = pruneFollowups(fn(current) ?? current, now)
        const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
        await writeFile(tmp, JSON.stringify({ v: 1, items: next }, null, 1), { mode: 0o600 })
        await rename(tmp, path)
        return next
    })
}

export async function recordFollowup(path: string, entry: Followup): Promise<void> {
    await mutateFollowups(path, items => [...items.filter(i => i.id !== entry.id), entry], entry.createdAt)
}

// ─── transitions (pure) ─────────────────────────────────────────────────────

export type FollowupSignal =
    | { type: 'turn_started'; sessionId: string; at: number }
    | { type: 'turn_ended'; sessionId: string; at: number }
    | { type: 'needs_input'; sessionId: string; at: number }
    | { type: 'session_exit'; sessionId: string; at: number; error: boolean }
    | { type: 'team_tasks'; teamId: string; tasks: Array<{ id: string; goal: string; status: string; ownerBotId?: string | null }>; bots?: Array<{ id: string; sessionId: string | null }>; at: number }
    | { type: 'issue'; issueId: string; status: string; at: number }

export type FollowupEventKind = 'followup_done' | 'followup_stuck' | 'followup_blocked'
export type FollowupStep = { item: Followup; event?: FollowupEventKind; nudge?: boolean }

const close = (item: Followup, state: FollowupState, at: number, result: string): Followup =>
    ({ ...item, state, updatedAt: at, closedAt: at, result: oneLine(result, FOLLOWUP_RESULT_MAX) })
const touch = (item: Followup, at: number, windowMs: number): Followup =>
    ({ ...item, updatedAt: at, lastActivityAt: at, dueAt: Math.max(item.dueAt, at + windowMs) })

/** What one observation means for one open entry. Unrelated signals return the entry unchanged. */
export function applyFollowupSignal(item: Followup, signal: FollowupSignal, windowMs: number): FollowupStep {
    if (item.state !== 'open') return { item }
    switch (signal.type) {
        case 'turn_started':
            return signal.sessionId === item.sessionId ? { item: touch(item, signal.at, windowMs) } : { item }
        case 'turn_ended':
            if (signal.sessionId !== item.sessionId || signal.at <= item.createdAt) return { item }
            // A Lead ending a turn has only (maybe) delegated it; its team task says when it is done.
            if (item.kind === 'lead') return { item: touch(item, signal.at, windowMs) }
            if (item.kind === 'spawn' || item.kind === 'send') return { item: close(item, 'done', signal.at, 'turn ended'), event: 'followup_done' }
            return { item }
        case 'needs_input':
            if (signal.sessionId !== item.sessionId || item.blockedAt !== undefined) return { item }
            return { item: { ...item, blockedAt: signal.at, updatedAt: signal.at }, event: 'followup_blocked' }
        case 'session_exit':
            if (signal.sessionId !== item.sessionId || !signal.error || item.kind === 'issue') return { item }
            return { item: close(item, 'stuck', signal.at, 'session ended with an error'), event: 'followup_stuck' }
        case 'team_tasks': {
            if (item.kind !== 'lead' || item.teamId !== signal.teamId) return { item }
            const task = signal.tasks.find(t => typeof t.goal === 'string' && t.goal.includes(followupTag(item.id)))
            if (task) {
                if (task.status === 'submitted' || task.status === 'done') return { item: close(item, 'done', signal.at, `team task ${task.id} ${task.status}`), event: 'followup_done' }
                if (task.status === 'cancelled') return { item: close(item, 'stuck', signal.at, `team task ${task.id} cancelled`), event: 'followup_stuck' }
                // queued / running: the Lead took it on and a member is on it — moving, not stuck.
                return { item: { ...touch(item, signal.at, windowMs), result: `team task ${task.id} ${task.status}` } }
            }
            // QA P2-2: the Lead rewrote the goal and the tag is gone. Tasks that appeared after the hand-over and that
            // the Lead owns are its delegation: any submitted / done → done; any queued / running → moving. Never stuck from here.
            if (!item.baselineTaskIds) return { item }
            const baseline = new Set(item.baselineTaskIds)
            const leadBots = new Set((signal.bots ?? []).filter(b => b.sessionId && b.sessionId === item.sessionId).map(b => b.id))
            const fresh = signal.tasks.filter(t => !baseline.has(t.id) && typeof t.ownerBotId === 'string' && leadBots.has(t.ownerBotId))
            const finished = fresh.find(t => t.status === 'submitted' || t.status === 'done')
            if (finished) return { item: close(item, 'done', signal.at, `team task ${finished.id} ${finished.status} (new since the hand-over)`), event: 'followup_done' }
            const moving = fresh.find(t => t.status === 'queued' || t.status === 'running')
            if (moving) return { item: { ...touch(item, signal.at, windowMs), result: `team task ${moving.id} ${moving.status} (new since the hand-over)` } }
            return { item }
        }
        case 'issue': {
            if (item.kind !== 'issue' || item.issueId !== signal.issueId) return { item }
            if (signal.status === 'done' || signal.status === 'in_review') return { item: close(item, 'done', signal.at, `issue ${signal.status}`), event: 'followup_done' }
            if (signal.status === 'cancelled') return { item: close(item, 'closed', signal.at, 'issue cancelled'), event: 'followup_done' }
            if (signal.status === 'blocked') return { item: close(item, 'stuck', signal.at, 'issue blocked'), event: 'followup_stuck' }
            return { item }
        }
    }
}

/**
 * The clock: an open entry past `dueAt` is chased once (level follow), and
 * reported stuck the next time (or at once when the level is report). A
 * target that is in a turn right now is moving, not stuck. Level off: nothing.
 */
export function tickFollowup(item: Followup, now: number, input: { level: MainAgentProactiveLevel; windowMs: number; busy: boolean }): FollowupStep {
    if (item.state !== 'open' || input.level === 'off' || now < item.dueAt) return { item }
    if (input.busy) return { item: touch(item, now, input.windowMs) }
    if (input.level === 'follow' && item.nudges === 0) {
        return { item: { ...item, nudges: 1, updatedAt: now, dueAt: now + input.windowMs }, nudge: true }
    }
    // QA P2-2: a Lead that has been active since the hand-over but shows no matching task is unclear, not stuck —
    // give it one more window before saying so (report level never asks the Lead itself).
    if (item.kind === 'lead' && item.nudges === 0 && item.lastActivityAt !== undefined && !item.extended) {
        return { item: { ...item, extended: true, updatedAt: now, dueAt: now + input.windowMs } }
    }
    return { item: close(item, 'stuck', now, item.nudges > 0 ? 'no answer after one nudge' : 'no sign of progress'), event: 'followup_stuck' }
}

/** The fixed nudge the daemon sends (VH-internal; the gate's keyword rules rate it `none`). */
export function followupNudgeText(item: Followup): string {
    if (item.kind === 'lead') {
        return `[Very Happy main agent → Lead] 跟进 ${item.id}：「${item.title}」还没看到对应的团队任务或结果。请回一句进展：拆给了谁、做到哪、卡在哪。`
    }
    if (item.kind === 'issue') return `跟进 ${item.id}：主 agent 在等这个 issue 的结果，还没看到进展。卡住了请说明卡在哪、需要什么。`
    return `[主 agent 跟进 ${item.id}] 主 agent 在等这件事的结果：「${item.title}」。做完了请回一句结论；卡住了请说清卡在哪、需要什么。`
}

/** One line per entry for `followups_list` (open first, newest first). */
export function formatFollowupLine(item: Followup, now: number): string {
    const age = Math.max(0, Math.round((now - item.createdAt) / 60_000))
    const target = item.kind === 'lead' ? `team=${item.teamId ?? '?'} lead=${item.sessionId ?? '?'}`
        : item.kind === 'issue' ? `issue=${item.issueKey ?? item.issueId ?? '?'}`
        : `session=${item.sessionId ?? '?'}`
    const due = item.state === 'open' ? `due=${Math.max(0, Math.round((item.dueAt - now) / 60_000))}m` : ''
    return [item.id, item.state, item.kind, `${age}m`, target, `"${oneLine(item.title, 60)}"`, item.nudges ? `nudged=${item.nudges}` : '', item.result ? `→ ${oneLine(item.result, 60)}` : '', due].filter(Boolean).join(' ')
}

export function sortFollowups(items: Followup[]): Followup[] {
    return [...items].sort((a, b) => (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1) || b.createdAt - a.createdAt)
}
