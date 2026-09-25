import { TZDate } from '@date-fns/tz';

/**
 * Five-field cron (minute hour day-of-month month day-of-week) evaluated in an
 * IANA time zone. Implemented in-repo because happy-server must not add npm
 * dependencies (PROCESS §3); the zone math comes from the existing
 * `@date-fns/tz` dependency.
 *
 * Semantics follow Vixie cron: `*`, lists, ranges, steps, month/weekday names,
 * `7` = Sunday, and day-of-month OR day-of-week when both are restricted.
 * Wall-clock times inside a DST gap run at the first instant after the gap;
 * ambiguous fall-back times run once (first occurrence).
 */
export type CronFields = { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domRestricted: boolean; dowRestricted: boolean };

const ALIASES: Record<string, string> = {
    '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
    '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export class CronParseError extends Error {
    constructor(message: string) { super(message); this.name = 'CronParseError'; }
}

function parseField(raw: string, min: number, max: number, names?: string[]): Set<number> {
    const out = new Set<number>();
    const token = (value: string): number => {
        const lower = value.toLowerCase();
        if (names) { const idx = names.indexOf(lower); if (idx >= 0) return min + idx; }
        if (!/^\d+$/.test(value)) throw new CronParseError(`invalid value "${value}"`);
        return Number(value);
    };
    for (const part of raw.split(',')) {
        if (!part) throw new CronParseError('empty list item');
        const [rangePart, stepPart, extra] = part.split('/');
        if (extra !== undefined) throw new CronParseError(`invalid step "${part}"`);
        const step = stepPart === undefined ? 1 : token(stepPart);
        if (step < 1) throw new CronParseError(`invalid step "${part}"`);
        let lo: number; let hi: number;
        if (rangePart === '*') { lo = min; hi = max; }
        else if (rangePart.includes('-')) {
            const [a, b, more] = rangePart.split('-');
            if (more !== undefined || !a || !b) throw new CronParseError(`invalid range "${part}"`);
            lo = token(a); hi = token(b);
        } else { lo = token(rangePart); hi = stepPart === undefined ? lo : max; }
        if (lo < min || hi > max || lo > hi) throw new CronParseError(`value out of range "${part}"`);
        for (let v = lo; v <= hi; v += step) out.add(v);
    }
    return out;
}

export function parseCron(expr: string): CronFields {
    const normalized = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
    const parts = normalized.split(/\s+/);
    if (parts.length !== 5) throw new CronParseError('expected five fields');
    const [m, h, dom, mon, dow] = parts;
    const dowSet = parseField(dow, 0, 7, DAYS);
    if (dowSet.has(7)) { dowSet.delete(7); dowSet.add(0); }
    return {
        minute: parseField(m, 0, 59), hour: parseField(h, 0, 23), dom: parseField(dom, 1, 31),
        month: parseField(mon, 1, 12, MONTHS), dow: dowSet,
        domRestricted: !dom.startsWith('*'), dowRestricted: !dow.startsWith('*'),
    };
}

export function isValidTimeZone(tz: string): boolean {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Wall-clock components carried as a UTC timestamp so calendar arithmetic can
// use Date.UTC without any zone involvement.
const wall = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo, d, h, mi);
function dayMatches(fields: CronFields, wallMs: number): boolean {
    const w = new Date(wallMs);
    const dom = fields.dom.has(w.getUTCDate());
    const dow = fields.dow.has(w.getUTCDay());
    if (fields.domRestricted && fields.dowRestricted) return dom || dow;
    return fields.domRestricted ? dom : fields.dowRestricted ? dow : true;
}
function nextInSet(set: Set<number>, from: number): number | null {
    let best: number | null = null;
    for (const v of set) if (v >= from && (best === null || v < best)) best = v;
    return best;
}

/** Next instant (epoch ms) strictly after `afterMs`, or null if none within ~5 years. */
export function nextCronAfter(fields: CronFields, tz: string, afterMs: number): number | null {
    const start = new TZDate(afterMs, tz);
    if (Number.isNaN(start.getTime())) return null;
    let cursor = wall(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes()) + 60_000;
    const limitYear = start.getFullYear() + 5;
    for (let guard = 0; guard < 400_000; guard++) {
        const w = new Date(cursor);
        if (w.getUTCFullYear() > limitYear) return null;
        if (!fields.month.has(w.getUTCMonth() + 1)) { cursor = wall(w.getUTCFullYear(), w.getUTCMonth() + 1, 1); continue; }
        if (!dayMatches(fields, cursor)) { cursor = wall(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() + 1); continue; }
        if (!fields.hour.has(w.getUTCHours())) {
            const h = nextInSet(fields.hour, w.getUTCHours() + 1);
            cursor = h === null ? wall(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() + 1) : wall(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), h);
            continue;
        }
        if (!fields.minute.has(w.getUTCMinutes())) {
            const mi = nextInSet(fields.minute, w.getUTCMinutes() + 1);
            cursor = mi === null ? wall(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours() + 1) : wall(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), mi);
            continue;
        }
        const instant = new TZDate(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), 0, tz).getTime();
        if (Number.isNaN(instant)) return null;
        // Fall-back overlap: wall clocks of the repeated hour resolve to the first
        // occurrence, which may already be behind `afterMs`; keep scanning.
        if (instant > afterMs) return instant;
        cursor += 60_000;
    }
    return null;
}
