import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec §2.6: issue content (title / description / comment bodies / run error
 * text) is plaintext server-side and must never reach a log line. Source
 * assertion over the issue module (the full-flow log capture test is
 * `issueLogCapture.pglite.integration.spec.ts`): every log call passes only
 * `{ module: 'issues', level, error }` and a fixed string literal, and there
 * is no console output. A refusal never answers 401/403 (Web: signed out).
 */
const dir = join(process.cwd(), 'sources/app/issues');
const sources = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.includes('.spec.') && f !== 'issueTestServer.ts')
    .map(f => ({ f, src: readFileSync(join(dir, f), 'utf8') }));
const routes = readFileSync(join(process.cwd(), 'sources/app/api/routes/issueRoutes.ts'), 'utf8');

describe('B-872 issue module never logs content', () => {
    it('scans the module files', () => {
        expect(sources.map(s => s.f).sort()).toEqual(['attentionBridge.ts', 'dispatch.ts', 'rules.ts', 'store.ts', 'todoImport.ts']);
    });

    it('every log call is { module: "issues", level, error } + a fixed message; no console / warn / error helpers', () => {
        for (const { f, src } of [...sources, { f: 'issueRoutes.ts', src: routes }]) {
            const calls = [...src.matchAll(/\blog\(([^;]*)\);/g)].map(m => m[1]);
            for (const args of calls) {
                expect(args, `${f}: ${args}`).toMatch(/^\{ module: 'issues', level: 'warn', error \}, '[^'`$]+'$/);
            }
            expect(src, f).not.toMatch(/console\.|\blogger\.|\b(?:warn|debug)\(/);
            expect(src, f).not.toMatch(/from '@\/utils\/log'.*\b(?:warn|error|debug)\b/);
        }
    });

    it('thrown issue errors carry a code literal and only id / limit details (the error message is the code)', () => {
        const allowed = new Set(['machineId', 'agent', 'limit', 'parentId', 'issue', 'message']);
        for (const { f, src } of sources) {
            for (const m of src.matchAll(/(?:new IssueError|requireIssue)\((?!condition: |code, status, details\))([^;]*?)\);/g)) {
                expect(m[1], f).toMatch(/'issues?_[a-z_]+'|'transaction_conflict'|'session_not_found'|check\.code/);
                const details = /, \d{3}, \{ ([^}]*) \}$/.exec(m[1]);
                for (const key of details ? details[1].split(',').map(k => k.trim().split(':')[0]) : []) expect(allowed.has(key), `${f}: ${key}`).toBe(true);
            }
            expect(src, f).not.toMatch(/(?:new IssueError|requireIssue)\([^;]*, 40[13]\b/);
        }
        expect(readFileSync(join(dir, 'rules.ts'), 'utf8')).toContain('constructor(public code: string, public status = 409, public details?: Record<string, unknown>) { super(code); }');
    });
});
