/**
 * B-688: line edits for a dotenv file (`~/.gemini/.env`). Other lines,
 * comments and order are kept; the result is re-parsed with dotenv and must
 * hold exactly the requested values with every other variable unchanged.
 */
import { parse } from 'dotenv';
import { ModelConfigError } from './fileStore';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

export function parseDotenv(text: string): Record<string, string> {
    return parse(text);
}

export function formatDotenvValue(value: string): string {
    if (/^[A-Za-z0-9_./:@+,-]*$/.test(value)) return value;
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** `value: null` removes every definition of the variable. */
export function editDotenv(text: string, edits: { key: string; value: string | null }[]): string {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    let lines = text === '' ? [] : text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const edit of edits) {
        const at = lines.map((l, i) => (LINE.exec(l)?.[1] === edit.key ? i : -1)).filter(i => i >= 0);
        if (edit.value === null) {
            lines = lines.filter((_, i) => !at.includes(i));
            continue;
        }
        const rendered = `${edit.key}=${formatDotenvValue(edit.value)}`;
        if (at.length) {
            lines[at[0]] = rendered;
            lines = lines.filter((_, i) => !at.slice(1).includes(i));
        } else {
            lines.push(rendered);
        }
    }
    const out = lines.length ? lines.join(eol) + eol : '';
    const before = parse(text);
    const after = parse(out);
    for (const edit of edits) {
        if ((after[edit.key] ?? null) !== edit.value) throw new ModelConfigError('unsafe-edit', `.env edit did not produce ${edit.key} as requested`);
        delete before[edit.key];
        delete after[edit.key];
    }
    if (JSON.stringify(Object.entries(before).sort()) !== JSON.stringify(Object.entries(after).sort())) {
        throw new ModelConfigError('unsafe-edit', '.env edit would change other variables');
    }
    return out;
}
