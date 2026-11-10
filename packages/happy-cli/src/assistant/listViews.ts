import type { ListFormatter } from './toolCaps'

/**
 * B-916b: one-line views of the JSON list answers on the main agent's
 * surface. The shared tools answer full objects (an automation with its
 * prompt, a run with its payload); a list of them blows past 4K after a few
 * entries. Each line keeps what a follow-up call needs (the id) plus what a
 * human-facing summary needs; the full object is one `*_get` away.
 * A formatter returns null for a shape it does not recognise, and the
 * answer is then paged as text instead.
 */

const iso = (ms: unknown) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16) + 'Z' : '-')
const q = (text: unknown, max = 60) => {
    if (typeof text !== 'string' || !text) return ''
    const one = text.replace(/\s+/g, ' ').trim()
    return `"${one.length > max ? `${one.slice(0, max - 1)}…` : one}"`
}

function trigger(t: any): string {
    if (!t || typeof t !== 'object') return '?'
    if (t.kind === 'cron') return `cron(${t.expr} ${t.tz})`
    if (t.kind === 'interval') return `every ${Math.round(Number(t.everyMs) / 60_000)}m`
    if (t.kind === 'once') return `once ${iso(t.at)}`
    return String(t.kind ?? '?')
}

const listOf = (value: unknown, key: string): any[] | null => {
    const list = (value as Record<string, unknown> | null)?.[key]
    return Array.isArray(list) ? list : null
}

export const automationListView: ListFormatter = (value) => {
    const list = listOf(value, 'automations')
    if (!list) return null
    if (list.length === 0) return 'no automations'
    return [`${list.length} automation(s) — name id status trigger next action:`,
        ...list.map(a => [a.name, a.id, a.status, trigger(a.trigger), `next=${iso(a.nextRunAt)}`, a.action?.kind ?? '', a.lastRunStatus ? `last=${a.lastRunStatus}` : ''].filter(Boolean).join(' '))].join('\n')
}

export const automationRunsView: ListFormatter = (value) => {
    const list = listOf(value, 'runs')
    if (!list) return null
    if (list.length === 0) return 'no runs'
    return [`${list.length} run(s), newest first — id automation status time session summary:`,
        ...list.map(r => [r.id, r.automationName, r.status, iso(r.finishedAt ?? r.startedAt ?? r.createdAt), r.sessionId ? `session=${r.sessionId}` : '', r.needsAttention ? '[needs attention]' : '', q(r.summary ?? r.error)].filter(Boolean).join(' '))].join('\n')
}

export const ownerBoardListView: ListFormatter = (value) => {
    const list = listOf(value, 'items')
    if (!list) return null
    if (list.length === 0) return 'no board items'
    return [`${list.length} item(s) — id kind state title [owner choice]:`,
        ...list.map(i => [i.id, i.kind, i.state, q(i.title, 80), i.ownerChoice ? `choice=${q(i.ownerChoice, 30)}` : '', i.ownerNote ? `note=${q(i.ownerNote, 30)}` : ''].filter(Boolean).join(' '))].join('\n')
}

export const MAIN_AGENT_LIST_VIEWS: Record<string, ListFormatter> = {
    automation_list: automationListView,
    automation_runs: automationRunsView,
    owner_board_list: ownerBoardListView,
}
