/**
 * B-924e: every `meta.sentFrom` value in the repo is classified — the owner typing in a client
 * (OWNER_SENT_FROM) or a program (PROGRAM_SENT_FROM). R61 shipped `mac` (the app on Mac Catalyst) unlisted,
 * so the owner's own Mac messages were not the owner's: wrap-up / hand-off refused, prompts marked
 * 「不是 Owner 本人发的」. A new client or program value now fails here until it is put in one list.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIENT_SENT_FROM, isOwnerTypedMessage, OWNER_SENT_FROM, PROGRAM_SENT_FROM } from './promptProvenance';

const PACKAGES = resolve(__dirname, '../..');
const SOURCE_ROOTS = ['src', 'sources'];
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.expo', 'src-tauri', 'target']);
const isTest = (f: string) => /\.(test|spec)\.tsx?$/.test(f) || f.includes('.integration.');

function* sourceFiles(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIR.has(name)) continue;
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) yield* sourceFiles(p);
        else if (/\.tsx?$/.test(name) && !isTest(name)) yield p;
    }
}

/** `sentFrom: 'x'`, `sentFrom = 'x'`, `sentFrom ?? 'x'`, `sentFrom === 'x'`, `X_SENT_FROM = 'x'`. */
const PATTERNS = [
    /\bsentFrom\??\s*(?:[:=]|===|!==)\s*['"]([^'"]+)['"]/g,
    /\bsentFrom\b[^,\n;]*\?\?\s*['"]([^'"]+)['"]/g,
    /_SENT_FROM\s*=\s*['"]([^'"]+)['"]/g,
];

function sentFromLiterals(): Map<string, string[]> {
    const found = new Map<string, string[]>();
    for (const pkg of readdirSync(PACKAGES)) {
        for (const root of SOURCE_ROOTS) {
            const dir = join(PACKAGES, pkg, root);
            try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
            for (const file of sourceFiles(dir)) {
                const text = readFileSync(file, 'utf8');
                for (const re of PATTERNS) for (const m of text.matchAll(re)) {
                    if (/typeof\s+[\w.?]*$/.test(text.slice(0, m.index))) continue; // `typeof x.sentFrom === 'string'`
                    const at = `${relative(PACKAGES, file)}:${text.slice(0, m.index).split('\n').length}`;
                    found.set(m[1], [...(found.get(m[1]) ?? []), at]);
                }
            }
        }
    }
    return found;
}

describe('B-924e sentFrom inventory', () => {
    const owner = new Set<string>(OWNER_SENT_FROM);
    const program = new Set<string>(PROGRAM_SENT_FROM);

    it('every client composer value is the owner; owner and program lists do not overlap', () => {
        for (const v of CLIENT_SENT_FROM) expect(owner.has(v), v).toBe(true);
        expect(owner.has('mac')).toBe(true);
        expect([...owner].filter(v => program.has(v))).toEqual([]);
        expect(isOwnerTypedMessage('c0ffee', 'mac')).toBe(true);
        for (const v of PROGRAM_SENT_FROM) expect(isOwnerTypedMessage('c0ffee', v), v).toBe(false);
    });

    it('every sentFrom literal in the repo is classified (owner or program)', () => {
        const found = sentFromLiterals();
        const unclassified = [...found].filter(([v]) => !owner.has(v) && !program.has(v));
        expect(unclassified, 'add each value to OWNER_SENT_FROM (a person typing in a client) or PROGRAM_SENT_FROM, and to the spec table').toEqual([]);
        // the scan still sees the writers it guards (a regex that stopped matching would pass vacuously)
        for (const v of [...CLIENT_SENT_FROM, ...PROGRAM_SENT_FROM]) expect(found.has(v), `${v} not found by the scan`).toBe(true);
    });
});
