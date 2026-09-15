const formatters = new Map<string, Intl.DateTimeFormat>();

function validTimestamp(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        && Number.isFinite(new Date(value).getTime());
}

type FormatterKind = 'date' | 'time' | 'zone' | 'compact';

const OPTIONS: Record<FormatterKind, Intl.DateTimeFormatOptions> = {
    date: { year: 'numeric', month: '2-digit', day: '2-digit' },
    time: { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' },
    zone: { timeZoneName: 'short' },
    compact: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
};

function timeFormatter(kind: FormatterKind, locale?: string, timeZone?: string): Intl.DateTimeFormat {
    const key = `${kind}:${locale ?? ''}:${timeZone ?? ''}`;
    let formatter = formatters.get(key);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat(locale, { ...OPTIONS[kind], ...(timeZone ? { timeZone } : {}) });
        formatters.set(key, formatter);
    }
    return formatter;
}

/**
 * Full local date/time for the message hover hint. Never infer a missing time.
 *
 * B-473: composed from three formatters instead of one options bag with every
 * field in it. ICU picks its own pattern for a combined skeleton, and for zh
 * that pattern wedges the zone between the date and the clock —
 * `2026/09/11 GMT+8 20:34:56`, which reads as a broken timestamp. Date, clock
 * and zone are formatted separately (each still locale-correct: zh keeps
 * y/m/d, en keeps m/d/y) and joined in one fixed order, so every locale gets
 * `<date> <HH:MM:SS> (<zone>)`.
 */
export function messageTimestamp(createdAt: number | null | undefined, locale?: string, timeZone?: string): string | undefined {
    if (!validTimestamp(createdAt)) return undefined;
    const date = timeFormatter('date', locale, timeZone).format(createdAt);
    const clock = timeFormatter('time', locale, timeZone).format(createdAt);
    const zone = timeFormatter('zone', locale, timeZone)
        .formatToParts(createdAt).find((part) => part.type === 'timeZoneName')?.value;
    return zone ? `${date} ${clock} (${zone})` : `${date} ${clock}`;
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
