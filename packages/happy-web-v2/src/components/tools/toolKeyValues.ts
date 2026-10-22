/**
 * Generic key/value presentation for tool calls nobody wrote a card for (B-754).
 *
 * An unknown MCP tool's arguments or JSON result become readable rows —
 * humanised field names, one-line values, URLs as links, short lists, nested
 * objects flattened a level or two — instead of a pretty-printed JSON block.
 * The untouched payload stays available in the card's collapsed raw-data
 * disclosure; this module only decides what the chat shows by default.
 *
 * Pure: never throws, never mutates.
 */
import { t } from '@/text';

export type KvKind = 'text' | 'mono' | 'multiline' | 'link' | 'list' | 'summary';

export interface KvRow {
    /** Stable key path (`a.b`), unique within one table. */
    key: string;
    /** Human label, e.g. `file_path` → "File path", `a.maxResults` → "A › Max results". */
    label: string;
    kind: KvKind;
    /** Display value (already truncated); for `list` the joined items. */
    value: string;
    items?: string[];
    /** Count of list items not shown. */
    more?: number;
    /** The value was shortened for display; the raw disclosure has it whole. */
    truncated?: boolean;
}

export interface KvOptions {
    /** Nested objects are flattened up to this depth (top level = 1). */
    maxDepth?: number;
    maxRows?: number;
    /** Single-line strings longer than this are clipped. */
    maxString?: number;
    /** Multi-line strings keep at most this many characters. */
    maxMultiline?: number;
    maxItems?: number;
}

const DEFAULTS: Required<KvOptions> = { maxDepth: 2, maxRows: 24, maxString: 160, maxMultiline: 600, maxItems: 8 };

const ACRONYMS: Record<string, string> = { id: 'ID', url: 'URL', uri: 'URI', ms: 'ms', api: 'API', ids: 'IDs', urls: 'URLs', json: 'JSON', html: 'HTML', ttl: 'TTL', pid: 'PID', cwd: 'cwd', sql: 'SQL' };

/** `file_path` / `maxResults` / `dry-run` → "File path" / "Max results" / "Dry run". */
export function humanizeKey(key: string): string {
    const words = key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[\s_\-.]+/)
        .filter(Boolean)
        .map((w) => w.toLowerCase());
    if (words.length === 0) return key;
    return words
        .map((w, i) => ACRONYMS[w] ?? (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
        .join(' ');
}

export function clip(text: string, max: number): { text: string; truncated: boolean } {
    if (text.length <= max) return { text, truncated: false };
    return { text: `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`, truncated: true };
}

const URL_RE = /^https?:\/\/\S+$/i;
const PATHISH_RE = /^(~|\.{0,2})\/[^\s]*$|^[A-Za-z]:\\[^\s]*$/;

/** A string that is itself a JSON object/array (common in MCP results). */
export function parseJsonText(text: string): unknown | undefined {
    const s = text.trim();
    if (!(s.startsWith('{') && s.endsWith('}')) && !(s.startsWith('[') && s.endsWith(']'))) return undefined;
    try {
        const v = JSON.parse(s);
        return typeof v === 'object' && v !== null ? v : undefined;
    } catch {
        return undefined;
    }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isEmpty(v: unknown): boolean {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string') return v.trim() === '';
    if (Array.isArray(v)) return v.length === 0;
    if (isPlainObject(v)) return Object.keys(v).length === 0;
    return false;
}

/** One line naming an object inside a list: its title/name/…, else its first short scalar. */
export function objectHeadline(o: Record<string, unknown>, max = 96): string {
    for (const k of ['title', 'name', 'label', 'summary', 'subject', 'text', 'content', 'message', 'url', 'path', 'id', 'key']) {
        const v = o[k];
        if (typeof v === 'string' && v.trim()) return clip(v.replace(/\s+/g, ' ').trim(), max).text;
        if (typeof v === 'number') return String(v);
    }
    for (const v of Object.values(o)) {
        if (typeof v === 'string' && v.trim()) return clip(v.replace(/\s+/g, ' ').trim(), max).text;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    }
    return t('tools.card.fields', { count: Object.keys(o).length });
}

function scalarText(v: unknown): string {
    if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return t('tools.card.items', { count: v.length });
    if (isPlainObject(v)) return objectHeadline(v);
    return String(v);
}

/**
 * Rows for a tool's arguments or a JSON result. A non-object value yields a
 * single row keyed `value`.
 */
export function keyValueRows(value: unknown, options: KvOptions = {}): KvRow[] {
    const o = { ...DEFAULTS, ...options };
    const rows: KvRow[] = [];
    let hidden = 0;
    const push = (row: KvRow) => {
        if (rows.length < o.maxRows) rows.push(row);
        else hidden += 1;
    };

    const visit = (key: string, label: string, v: unknown, depth: number) => {
        if (isEmpty(v)) return;
        if (typeof v === 'string') {
            const nested = parseJsonText(v);
            if (nested !== undefined && depth < o.maxDepth) {
                visit(key, label, nested, depth);
                return;
            }
            const s = v.trim();
            if (URL_RE.test(s)) {
                push({ key, label, kind: 'link', value: s });
                return;
            }
            if (s.includes('\n') || s.length > o.maxString) {
                const multiline = s.includes('\n');
                const c = clip(s, multiline ? o.maxMultiline : o.maxString);
                push({ key, label, kind: multiline ? 'multiline' : 'text', value: c.text, truncated: c.truncated });
                return;
            }
            push({ key, label, kind: PATHISH_RE.test(s) ? 'mono' : 'text', value: s });
            return;
        }
        if (typeof v === 'number' || typeof v === 'boolean') {
            push({ key, label, kind: 'mono', value: String(v) });
            return;
        }
        if (Array.isArray(v)) {
            const shown = v.slice(0, o.maxItems).filter((x) => !isEmpty(x)).map((x) => clip(scalarText(x), o.maxString).text);
            push({ key, label, kind: 'list', value: shown.join(', '), items: shown, more: Math.max(0, v.length - o.maxItems) || undefined });
            return;
        }
        if (isPlainObject(v)) {
            if (depth >= o.maxDepth) {
                push({ key, label, kind: 'summary', value: objectHeadline(v) });
                return;
            }
            for (const [k, child] of Object.entries(v)) {
                visit(key ? `${key}.${k}` : k, label ? `${label} › ${humanizeKey(k)}` : humanizeKey(k), child, depth + 1);
            }
            return;
        }
        push({ key, label, kind: 'text', value: String(v) });
    };

    if (isPlainObject(value)) visit('', '', value, 0);
    else if (Array.isArray(value)) {
        // A bare list result: one row per entry, named by its headline.
        value.slice(0, o.maxRows).forEach((item, i) => {
            if (isPlainObject(item)) push({ key: String(i), label: `#${i + 1}`, kind: 'text', value: objectHeadline(item, o.maxString) });
            else if (!isEmpty(item)) visit(String(i), `#${i + 1}`, item, o.maxDepth);
        });
        hidden += Math.max(0, value.length - o.maxRows);
    } else if (!isEmpty(value)) visit('value', t('tools.card.value'), value, o.maxDepth);

    if (hidden > 0) rows.push({ key: '…', label: '…', kind: 'summary', value: t('tools.card.moreFields', { count: hidden }) });
    return rows;
}

/** Pretty JSON for the collapsed raw-data disclosure; never throws. */
export function rawJson(value: unknown): string {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2) ?? '';
    } catch {
        return String(value);
    }
}
