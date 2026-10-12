/**
 * B-558: a user stop of a Codex turn leaves the same `Aborted by user` lifecycle
 * line Claude does (web: presentServiceEvent → "stopped by you"), and only when
 * the stop actually ended an active turn. Source assertion verified with
 * scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../runCodex.ts', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');

describe('Codex user stop lifecycle event', () => {
    it('emits Aborted by user right after the interrupt, guarded by an aborted active turn', () => {
        const at = source.indexOf('const abortResult = await client.abortTurnWithFallback({');
        expect(at).toBeGreaterThan(0);
        const tail = source.slice(at, at + 700);
        expect(tail).toContain("if (source === 'user' && abortResult.hadActiveTurn && abortResult.aborted) {\n                        session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });");
        expect(tail.indexOf("'Aborted by user'")).toBeLessThan(tail.indexOf('if (abortResult.forcedRestart) {'));
    });
    it('only the abort RPC is a user stop; kill / signal / local exit are not (Claude: !exitReason)', () => {
        expect(source).toContain("registerHandler('abort', () => handleAbort('user'));");
        expect(source).toContain("await handleAbort('kill');");
        expect(source).toContain("await handleAbort('exit');");
        expect(source).not.toMatch(/handleAbort\(\)/);
        expect(source).not.toContain("registerHandler('abort', handleAbort)");
    });
});
