/**
 * B-925 quiet hours of the main agent: KV `vh.main-agent-config.v1`.quietHours, parsed by B-924's wire
 * reader (`parseMainAgentQuietHours`, the same one the server's push rule uses). Here: the zone resolved
 * (null = this machine's local zone) and the window test the daemon uses to tell a woken main agent to stay
 * on the board.
 */

import { DEFAULT_QUIET_HOURS, parseMainAgentQuietHours } from '@slopus/happy-wire'

export type QuietHours = { enabled: boolean; start: string; end: string; tz: string }
export const QUIET_HOURS_DEFAULT: Omit<QuietHours, 'tz'> = { enabled: DEFAULT_QUIET_HOURS.enabled, start: DEFAULT_QUIET_HOURS.start, end: DEFAULT_QUIET_HOURS.end }
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

function validZone(tz: unknown): tz is string {
    if (typeof tz !== 'string' || !tz || tz.length > 64) return false
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

export function readQuietHours(config: unknown, fallbackTz = 'UTC'): QuietHours {
    const raw = config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>).quietHours : undefined
    const q = parseMainAgentQuietHours(raw)
    return { enabled: q.enabled, start: q.start, end: q.end, tz: validZone(q.tz) ? q.tz : validZone(fallbackTz) ? fallbackTz : 'UTC' }
}

/** Start inclusive, end exclusive; start === end = never; a window may wrap midnight. */
export function isQuietTime(quiet: QuietHours, now: number): boolean {
    if (!quiet.enabled) return false
    const toMin = (v: string) => { const m = HHMM.exec(v); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN }
    const start = toMin(quiet.start)
    const end = toMin(quiet.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false
    let minute: number
    try {
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: quiet.tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(now))
        minute = Number(parts.find(p => p.type === 'hour')?.value) * 60 + Number(parts.find(p => p.type === 'minute')?.value)
    } catch { return false }
    if (!Number.isFinite(minute)) return false
    return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

/** `YYYY-MM-DD` of `now` in `tz` (the budget's "day"). */
export function localDay(now: number, tz: string): string {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
    } catch {
        return new Date(now).toISOString().slice(0, 10)
    }
}
