/**
 * B-858 wiring: the wrapper moves HAPPY_RECONNECT_* off process.env before it
 * spawns anything, and every runner reads the in-memory copy. Source
 * assertions, verified with scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\n(?:[ \t]*\n)+/g, '\n');
const sources = (dir: string): string[] => readdirSync(join(SRC, dir)).flatMap((name) => {
    const rel = join(dir, name);
    if (statSync(join(SRC, rel)).isDirectory()) return sources(rel);
    return rel.endsWith('.ts') && !rel.endsWith('.test.ts') ? [rel] : [];
});

describe('reconnect env stays off process.env (B-858)', () => {
    it('main() stashes it before anything else', () => {
        const main = read('main.ts');
        const body = main.slice(main.indexOf('export async function main(): Promise<void> {'));
        expect(body.split('\n')[1].trim()).toBe('stashReconnectEnv()');
    });

    it('each runner takes the hand-off instead of reading process.env', () => {
        expect(read('claude/runClaude.ts')).toContain('const reconnectEnv = takeReconnectEnv();');
        expect(read('codex/runCodex.ts')).toContain('const reconnectEnv = takeReconnectEnv();');
        expect(read('agent/acp/runAcp.ts')).toContain('readAcpReconnectEnv(takeReconnectEnv())');
    });

    it('a reconnect still rules the Claude prewarm out', () => {
        expect(read('claude/runClaude.ts')).toContain('reconnect: reconnectRequested,');
    });

    it('no wrapper code reads HAPPY_RECONNECT_* from process.env', () => {
        const offenders = sources('.')
            .filter((file) => file !== 'daemon/run.ts') // the daemon sets them on the child
            .filter((file) => /process\.env\.HAPPY_RECONNECT_|process\.env\[['"]HAPPY_RECONNECT_|ReconnectEnv\(process\.env\)/.test(read(file)));
        expect(offenders).toEqual([]);
    });
});
