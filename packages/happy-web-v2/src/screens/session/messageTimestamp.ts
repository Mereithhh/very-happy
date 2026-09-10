const formatters = new Map<string, Intl.DateTimeFormat>();

function validTimestamp(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        && Number.isFinite(new Date(value).getTime());
}

function timeFormatter(style: 'full' | 'compact', locale?: string, timeZone?: string): Intl.DateTimeFormat {
    const key = `${style}:${locale ?? ''}:${timeZone ?? ''}`;
    let formatter = formatters.get(key);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat(locale, {
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
            ...(style === 'full' ? {
                year: 'numeric', month: '2-digit', day: '2-digit',
                second: '2-digit', timeZoneName: 'short',
            } as const : {}),
            ...(timeZone ? { timeZone } : {}),
        });
        formatters.set(key, formatter);
    }
    return formatter;
}

/** Full local date/time for passive message hover hints. Never infer a missing time. */
export function messageTimestamp(createdAt: number | null | undefined, locale?: string, timeZone?: string): string | undefined {
    if (!validTimestamp(createdAt)) return undefined;
    return timeFormatter('full', locale, timeZone).format(createdAt);
}

/** Always-visible message action time; the complete date remains available in the hover hint. */
export function compactMessageTime(createdAt: number | null | undefined, locale?: string, timeZone?: string): string | undefined {
    if (!validTimestamp(createdAt)) return undefined;
    return timeFormatter('compact', locale, timeZone).format(createdAt);
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
