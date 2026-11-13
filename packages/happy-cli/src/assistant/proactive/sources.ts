/**
 * B-925: which raw signals are worth waking the main agent for. Pure — the
 * daemon feeds board items, automation runs, session exits and follow-up
 * steps; anything not listed here never becomes an event (and costs nothing).
 *
 * Worth it:
 *  - a root team task submitted and waiting for the owner's acceptance (the
 *    server's `team` decision card);
 *  - a `request_human` card (`blocked`, from an agent) open for too long;
 *  - an automation run that failed (skipped runs are not failures);
 *  - a session that exited abnormally (not stopped, hibernated or restarted);
 *  - the main agent's own follow-ups: done, stuck, waiting for input.
 * Never: anything about the main agent's own session, closed cards, member
 * tasks inside a team (no owner card), normal exits, successful or skipped runs.
 */

import { isAttentionActive, type AttentionItem, type AutomationRun } from '@slopus/happy-wire'
import type { Followup, FollowupEventKind } from './ledger'
import { oneLine } from './ledger'
import type { WakeEvent } from './wake'

export function eventsFromBoard(items: ReadonlyArray<Pick<AttentionItem, 'id' | 'sessionId' | 'teamId' | 'source' | 'kind' | 'key' | 'title' | 'state' | 'createdAt' | 'repostCount'>>, ctx: { mainAgentSessionId: string | null; now: number; requestHumanMs: number }): WakeEvent[] {
    const out: WakeEvent[] = []
    for (const item of items) {
        if (!isAttentionActive(item.state) || item.sessionId === ctx.mainAgentSessionId) continue
        if (item.source === 'team' && item.kind === 'decision') {
            out.push({ key: `team:${item.id}:${item.repostCount ?? 0}`, kind: 'team_submitted', title: item.title, sessionId: item.sessionId, detail: `卡片 ${item.id}${item.teamId ? ` · 团队 ${item.teamId}` : ''} · 会话 ${item.sessionId}`, at: ctx.now })
        } else if (item.source === 'agent' && item.kind === 'blocked' && ctx.now - item.createdAt >= ctx.requestHumanMs) {
            const minutes = Math.round((ctx.now - item.createdAt) / 60_000)
            out.push({ key: `rh:${item.id}:${item.repostCount ?? 0}`, kind: 'request_human_stale', title: item.title, sessionId: item.sessionId, detail: `已等 ${minutes} 分钟 · 会话 ${item.sessionId} · 卡片 ${item.id}`, at: ctx.now })
        }
    }
    return out
}

export function eventsFromRuns(runs: ReadonlyArray<Pick<AutomationRun, 'id' | 'automationName' | 'status' | 'error' | 'attentionReason' | 'sessionId' | 'finishedAt' | 'updatedAt'>>, ctx: { since: number; now: number }): WakeEvent[] {
    return runs
        .filter(r => r.status === 'failed' && (r.finishedAt ?? r.updatedAt) >= ctx.since)
        .map(r => ({
            key: `run:${r.id}`, kind: 'automation_failed' as const,
            title: `${r.automationName}：${oneLine(r.error ?? r.attentionReason ?? 'failed', 90)}`,
            detail: `run ${r.id}${r.sessionId ? ` · 会话 ${r.sessionId}` : ''}`, sessionId: r.sessionId ?? null, at: ctx.now,
        }))
}

export type SessionExitInfo = {
    sessionId: string
    pid: number
    title: string
    code: number | null
    signal: string | null
    /** The owner / daemon asked it to stop. */
    requested: boolean
    hibernated: boolean
    autoRestart: boolean
    isMainAgent: boolean
}

const CRASH_SIGNALS = new Set(['SIGSEGV', 'SIGABRT', 'SIGBUS', 'SIGILL'])
/** Exit codes of a wrapper that was told to stop (SIGHUP / SIGINT / SIGTERM handled → 128+n). SIGKILL is the daemon's own stop fallback. */
const STOP_CODES = new Set([0, 129, 130, 143])

export function eventFromSessionExit(x: SessionExitInfo, now: number): WakeEvent | null {
    if (x.isMainAgent || x.requested || x.hibernated || x.autoRestart) return null
    const crashed = (x.code !== null && !STOP_CODES.has(x.code)) || (x.signal !== null && CRASH_SIGNALS.has(x.signal))
    if (!crashed) return null
    return {
        key: `exit:${x.sessionId}:${x.pid}`, kind: 'session_error', title: x.title, sessionId: x.sessionId,
        // B-924's hourly check posts the stuck card; same key → the same card, never a second one.
        detail: `会话 ${x.sessionId} · ${x.code !== null ? `退出码 ${x.code}` : `信号 ${x.signal}`} · 发卡用 key main-agent-stuck:${x.sessionId}`,
        at: now,
    }
}

/** `sessionTitle`: the dispatched session's own title (PRECHECK title column, QA-T R62 P3-1); unknown → ''. */
export function eventFromFollowup(kind: FollowupEventKind, item: Followup, now: number, sessionTitle?: string | null): WakeEvent {
    const target = item.kind === 'lead' ? `团队 ${item.teamId ?? '?'} · Lead 会话 ${item.sessionId ?? '?'}`
        : item.kind === 'issue' ? `issue ${item.issueKey ?? item.issueId ?? '?'}`
        : `会话 ${item.sessionId ?? '?'}`
    const suffix = kind === 'followup_blocked' ? 'blocked' : kind === 'followup_done' ? 'done' : 'stuck'
    return {
        key: `followup:${item.id}:${suffix}`, kind, title: item.title || item.id, sessionId: item.kind === 'issue' ? null : item.sessionId ?? null,
        sessionTitle: sessionTitle?.trim() ?? '',
        detail: [`跟进 ${item.id}`, target, item.result ? oneLine(item.result, 80) : ''].filter(Boolean).join(' · '),
        at: now,
    }
}
