import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-014 — the web tab's background RPC budget.
 *
 * Measured on production (2026-09-07, ~/code/github/skills/tmp/vh-rpc-limit):
 * one idle tab emitted 110–172 RPC/min, 100% of them session-scoped `bash`
 * from `gitStatusSync` — 4 git commands per invalidation, fanned out to every
 * running agent because `handleUpdate`'s new-message branch calls
 * `onSessionVisible(sid)` for EVERY session's messages. The result
 * (`pathGitStatus`) had no UI consumer. These assertions keep that fan-out
 * from coming back in any of its three shapes: the module, a call from the
 * update handlers, or a subscription-less store slice that invites one.
 */
const read = (relative: string) => readFileSync(join(__dirname, relative), 'utf8');

describe('no automatic git-status RPC fan-out (T-014)', () => {
    it('the gitStatusSync module is gone, not merely unused', () => {
        expect(existsSync(join(__dirname, 'gitStatusSync.ts'))).toBe(false);
    });

    it('sync.ts neither imports it nor runs git on message/agentState updates', () => {
        const source = read('./sync.ts');
        expect(source).not.toContain('gitStatusSync');
        expect(source).not.toContain('isMutableToolCall');
        // The only git/bash RPCs the web issues are user-driven (Files panel
        // open/refresh via useSessionFiles); sync.ts issues none.
        expect(source).not.toMatch(/sessionBash\(/);
        expect(source).not.toMatch(/'bash'/);
    });

    it('storage.ts carries no unrendered git-status slice', () => {
        const source = read('./storage.ts');
        expect(source).not.toContain('pathGitStatus:');
        expect(source).not.toContain('applyGitStatus:');
        expect(source).not.toContain('useSessionGitStatus(');
        // The on-demand, rendered slice stays.
        expect(source).toContain('pathGitStatusFiles:');
        expect(source).toContain('useSessionGitStatusFiles(');
    });

    it('onSessionVisible is still fired per incoming message (its other duties stand), so it must stay RPC-free', () => {
        const source = read('./sync.ts');
        const start = source.indexOf('onSessionVisible = (sessionId: string) => {');
        expect(start).toBeGreaterThan(-1);
        const body = source.slice(start, source.indexOf('\n    }\n', start));
        expect(body).not.toMatch(/sessionRPC|machineRPC|sessionBash/);
        // Exactly one invalidation, and it is the messages sync — a REST fetch,
        // not a daemon RPC.
        expect(body.match(/\.invalidate\(\)/g)).toHaveLength(1);
        expect(body).toContain('this.getMessagesSync(sessionId).invalidate()');
    });
});
