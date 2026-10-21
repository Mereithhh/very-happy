/**
 * B-688: surgical TOML edits that keep every byte we don't own — comments,
 * ordering, blank lines, other tables. No TOML library round-trips comments,
 * so instead of parse → stringify this edits lines and then PROVES the result
 * with a real parser (smol-toml): the new document must parse, hold exactly the
 * requested values, and be semantically equal to the old one everywhere else
 * (`verifyTomlEdit`). Anything the line scanner can't place safely (a key we
 * own spread over several lines, a dotted-key definition of a table we would
 * create) fails that proof and the edit is refused, never half-applied.
 */
import { parse } from 'smol-toml';
import { ModelConfigError } from './fileStore';

export type TomlScalar = string | boolean;

export type TomlEdit =
    | { table: string[]; key: string; value: TomlScalar | null }
    | { table: string[]; removeTable: true };

interface Section {
    /** null for the root (before the first header). */
    path: string[] | null;
    arrayTable: boolean;
    headerLine: number;
    /** first body line (inclusive) */
    start: number;
    /** end (exclusive) */
    end: number;
    keys: Map<string, number>;
    /** last line index holding a key/value (or the header) — insertion anchor */
    lastKeyLine: number;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function formatTomlKey(key: string): string {
    return BARE_KEY.test(key) ? key : JSON.stringify(key);
}

export function formatTomlValue(value: TomlScalar): string {
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    // JSON string escapes are a subset of TOML basic-string escapes, except
    // TOML also forbids a raw DEL.
    return JSON.stringify(value).replace(/\u007f/g, '\\u007F');
}

/** Split a dotted key / header body into its parts ("a".b.'c d' → [a, b, c d]). */
export function splitDottedKey(raw: string): string[] | null {
    const parts: string[] = [];
    let i = 0;
    const s = raw.trim();
    while (i < s.length) {
        while (s[i] === ' ' || s[i] === '\t') i++;
        let part = '';
        if (s[i] === '"') {
            let j = i + 1;
            while (j < s.length && s[j] !== '"') { if (s[j] === '\\') j++; j++; }
            if (j >= s.length) return null;
            try { part = JSON.parse(s.slice(i, j + 1)); } catch { return null; }
            i = j + 1;
        } else if (s[i] === "'") {
            const j = s.indexOf("'", i + 1);
            if (j < 0) return null;
            part = s.slice(i + 1, j);
            i = j + 1;
        } else {
            let j = i;
            while (j < s.length && /[A-Za-z0-9_-]/.test(s[j])) j++;
            if (j === i) return null;
            part = s.slice(i, j);
            i = j;
        }
        parts.push(part);
        while (s[i] === ' ' || s[i] === '\t') i++;
        if (i >= s.length) break;
        if (s[i] !== '.') return null;
        i++;
    }
    return parts.length ? parts : null;
}

/**
 * Line scanner. Tracks multi-line strings and bracket depth so a `[x]` inside
 * a multi-line array or string is not mistaken for a header.
 */
function scan(lines: string[]): Section[] {
    const sections: Section[] = [{ path: null, arrayTable: false, headerLine: -1, start: 0, end: lines.length, keys: new Map(), lastKeyLine: -1 }];
    let inMulti: '"""' | "'''" | null = null;
    let depth = 0;
    for (let n = 0; n < lines.length; n++) {
        const line = lines[n];
        const current = sections[sections.length - 1];
        if (inMulti) {
            if (line.includes(inMulti)) {
                inMulti = null;
                current.lastKeyLine = n;
            }
            continue;
        }
        const trimmed = line.trim();
        if (depth === 0) {
            const header = /^\[(\[)?\s*([^\[\]]+?)\s*\](\])?\s*(#.*)?$/.exec(trimmed);
            if (header) {
                current.end = n;
                const path = splitDottedKey(header[2]);
                sections.push({ path: path ?? [`\u0000invalid:${header[2]}`], arrayTable: !!header[1], headerLine: n, start: n + 1, end: lines.length, keys: new Map(), lastKeyLine: n });
                continue;
            }
            const kv = /^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.\s"'-])+?)\s*=/.exec(trimmed);
            if (kv) {
                const keyPath = splitDottedKey(kv[1]);
                if (keyPath) current.keys.set(keyPath.join('\u0000'), n);
                current.lastKeyLine = n;
            }
        } else if (trimmed) {
            current.lastKeyLine = n;
        }
        // Update string / bracket state for the rest of the line.
        let i = 0;
        while (i < line.length) {
            const ch = line[i];
            if (ch === '#') break;
            if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
                const fence = line.slice(i, i + 3) as '"""' | "'''";
                const close = line.indexOf(fence, i + 3);
                if (close < 0) { inMulti = fence; break; }
                i = close + 3;
                continue;
            }
            if (ch === '"') {
                i++;
                while (i < line.length && line[i] !== '"') { if (line[i] === '\\') i++; i++; }
                i++;
                continue;
            }
            if (ch === "'") {
                const close = line.indexOf("'", i + 1);
                i = close < 0 ? line.length : close + 1;
                continue;
            }
            if (ch === '[' || ch === '{') depth++;
            if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
            i++;
        }
    }
    return sections;
}

/** ` # comment` after a single-line scalar value, kept when we replace that value. */
function trailingComment(line: string): string {
    const m = /^\s*[^=]+=\s*("(?:[^"\\]|\\.)*"|'[^']*'|true|false|[0-9][0-9_.eE+-]*)(\s+#.*)$/.exec(line);
    return m ? m[2] : '';
}

const samePath = (a: string[] | null, b: string[]) => a !== null && a.length === b.length && a.every((p, i) => p === b[i]);
const isUnder = (a: string[] | null, prefix: string[]) => a !== null && a.length >= prefix.length && prefix.every((p, i) => p === a[i]);

function applyOne(text: string, edit: TomlEdit): string {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const sections = scan(lines);
    if ('removeTable' in edit) {
        const doomed = sections.filter(s => !s.arrayTable && isUnder(s.path, edit.table)).sort((a, b) => b.headerLine - a.headerLine);
        for (const s of doomed) {
            // Trim one trailing blank line along with the table.
            let end = s.end;
            while (end > s.start && lines[end - 1]?.trim() === '' && end - 1 > s.lastKeyLine) end--;
            lines.splice(s.headerLine, end - s.headerLine);
        }
        return lines.join(eol).replace(/(\r?\n){3,}/g, `${eol}${eol}`).replace(/(\r?\n)+$/, eol);
    }
    const root = edit.table.length === 0;
    const section = root ? sections[0] : sections.find(s => !s.arrayTable && samePath(s.path, edit.table));
    const keyId = edit.key;
    const rendered = edit.value === null ? null : `${formatTomlKey(edit.key)} = ${formatTomlValue(edit.value)}`;
    if (section) {
        const at = section.keys.get(keyId);
        if (at !== undefined) {
            const indent = /^\s*/.exec(lines[at])?.[0] ?? '';
            if (rendered === null) lines.splice(at, 1);
            else lines[at] = indent + rendered + trailingComment(lines[at]);
            return lines.join(eol);
        }
        if (rendered === null) return text;
        if (root) {
            const anchor = section.lastKeyLine;
            lines.splice(anchor + 1, 0, rendered);
        } else {
            lines.splice(section.lastKeyLine + 1, 0, rendered);
        }
        return lines.join(eol);
    }
    if (rendered === null) return text;
    // New table at the end of the document.
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    const header = `[${edit.table.map(formatTomlKey).join('.')}]`;
    if (lines.length) lines.push('');
    lines.push(header, rendered, '');
    return lines.join(eol);
}

export function parseToml(text: string): Record<string, unknown> {
    try {
        return parse(text) as Record<string, unknown>;
    } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
        throw new ModelConfigError('invalid-toml', `Not valid TOML: ${message}`);
    }
}

function getPath(obj: unknown, path: string[]): unknown {
    let cur = obj;
    for (const p of path) {
        if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
        cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
}

function withoutPaths(obj: unknown, paths: string[][]): unknown {
    const clone = structuredClone(obj) as Record<string, unknown>;
    for (const path of paths) {
        let cur: unknown = clone;
        for (const p of path.slice(0, -1)) {
            if (!cur || typeof cur !== 'object') { cur = null; break; }
            cur = (cur as Record<string, unknown>)[p];
        }
        if (cur && typeof cur === 'object') delete (cur as Record<string, unknown>)[path[path.length - 1]];
    }
    return clone;
}

/** Drop empty tables left behind (a table we emptied is not a semantic change). */
function pruneEmpty(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const pruned = pruneEmpty(v);
        if (pruned && typeof pruned === 'object' && !Array.isArray(pruned) && !(pruned instanceof Date) && Object.keys(pruned).length === 0) continue;
        out[k] = pruned;
    }
    return out;
}

function stableStringify(value: unknown): string {
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/** The proof described in the header. Throws `unsafe-edit` on any mismatch. */
export function verifyTomlEdit(oldText: string, newText: string, edits: TomlEdit[]): void {
    const before = parseToml(oldText);
    let after: Record<string, unknown>;
    try {
        after = parse(newText) as Record<string, unknown>;
    } catch (error) {
        throw new ModelConfigError('unsafe-edit', `Edit would produce invalid TOML (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); the file layout is not one this editor can change safely`);
    }
    const owned: string[][] = edits.map(e => ('removeTable' in e ? e.table : [...e.table, e.key]));
    for (const edit of edits) {
        if ('removeTable' in edit) {
            if (getPath(after, edit.table) !== undefined) throw new ModelConfigError('unsafe-edit', `Table ${edit.table.join('.')} is still present after removal`);
            continue;
        }
        const got = getPath(after, [...edit.table, edit.key]);
        const want = edit.value === null ? undefined : edit.value;
        if (got !== want) throw new ModelConfigError('unsafe-edit', `Key ${[...edit.table, edit.key].join('.')} did not take the requested value`);
    }
    if (stableStringify(pruneEmpty(withoutPaths(before, owned))) !== stableStringify(pruneEmpty(withoutPaths(after, owned)))) {
        throw new ModelConfigError('unsafe-edit', 'Edit would change settings outside the keys Very Happy manages');
    }
}

/** Apply edits in order and verify. The input must already be valid TOML. */
export function editToml(text: string, edits: TomlEdit[]): string {
    parseToml(text);
    let out = text;
    // Root keys first: a key inserted after a table header would land inside that table.
    const ordered = [...edits.filter(e => e.table.length === 0), ...edits.filter(e => e.table.length > 0)];
    for (const edit of ordered) out = applyOne(out, edit);
    if (out !== text && !out.endsWith('\n')) out += text.includes('\r\n') ? '\r\n' : '\n';
    verifyTomlEdit(text, out, edits);
    return out;
}
