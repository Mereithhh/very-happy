const formatters = new Map<string, Intl.DateTimeFormat>();

function validTimestamp(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        && Number.isFinite(new Date(value).getTime());
}

/** Full local date/time for passive message hover hints. Never infer a missing time. */
export function messageTimestamp(createdAt: number | null | undefined, locale?: string, timeZone?: string): string | undefined {
    if (!validTimestamp(createdAt)) return undefined;
    const key = `${locale ?? ''}:${timeZone ?? ''}`;
    let formatter = formatters.get(key);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat(locale, {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hourCycle: 'h23', timeZoneName: 'short', ...(timeZone ? { timeZone } : {}),
        });
        formatters.set(key, formatter);
    }
    return formatter.format(createdAt);
}

/** A collapsed tool group represents several messages, so show their real range. */
export function messageTimestampRange(createdAt: Array<number | null | undefined>, locale?: string, timeZone?: string): string | undefined {
    const known = createdAt.filter(validTimestamp);
    if (known.length === 0) return undefined;
    const first = Math.min(...known);
    const last = Math.max(...known);
    const start = messageTimestamp(first, locale, timeZone);
    const end = messageTimestamp(last, locale, timeZone);
    return start === end ? start : `${start} – ${end}`;
}
