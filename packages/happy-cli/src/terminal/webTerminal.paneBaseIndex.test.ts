/**
 * Regression: a user's tmux.conf with `base-index 1` / `pane-base-index 1`
 * (very common in dotfiles) must not break the web terminal. Before the fix the
 * open-time capture batch addressed the pane as `=vh-<id>:.0`, tmux answered
 * "can't find pane: 0" and every open surfaced as `terminal-open-timeout`
 * (2026-09-01, colleague's ECS). The pane is now addressed as the session's
 * active pane (`=vh-<id>:`) / its `%id`, which is index-agnostic.
 *
 * Runs against a REAL tmux server on a private socket (src/testing/isolatedTmux.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedTmux, tmuxAvailable } from '@/testing/isolatedTmux';

// Isolated HAPPY_HOME_DIR BEFORE importing webTerminal (configuration is an
// import-time singleton): tombstones / live-terminals must never touch ~/.happy.
const happyHome = mkdtempSync(join(tmpdir(), 'vh-pbi-home-'));
const prevHome = process.env.HAPPY_HOME_DIR;
process.env.HAPPY_HOME_DIR = happyHome;
const iso = createIsolatedTmux('vh-pbi');
const { WebTerminalManager } = await import('./webTerminal');
const TID = 'pbindex01';

describe.skipIf(!tmuxAvailable)('web terminal with base-index 1 / pane-base-index 1 (real tmux)', () => {
    let mgr: InstanceType<typeof WebTerminalManager>;
    const frames: Array<{ event: string; payload: any }> = [];

    beforeAll(() => {
        // Options live on the server: boot it with a throwaway session, then
        // apply what a typical ~/.tmux.conf does. Every later vh-* session
        // inherits window index 1 / pane index 1 — no `:.0` pane exists.
        expect(iso.run('new-session', '-d', '-s', 'cfg-holder').status).toBe(0);
        expect(iso.run('set-option', '-g', 'base-index', '1').status).toBe(0);
        expect(iso.run('set-option', '-g', 'pane-base-index', '1').status).toBe(0);
        mgr = new WebTerminalManager((event, payload) => { frames.push({ event, payload }); });
    });

    afterAll(() => {
        mgr?.stopListTracking();
        try { mgr?.killSession(TID); } catch { /* already gone */ }
        iso.dispose();
        if (prevHome === undefined) delete process.env.HAPPY_HOME_DIR; else process.env.HAPPY_HOME_DIR = prevHome;
        rmSync(happyHome, { recursive: true, force: true });
    });

    it('opens, captures and accepts input when the only pane is index 1', async () => {
        const result = await mgr.open({ terminalId: TID, cols: 80, rows: 24, cwd: iso.dir });
        expect(result.terminalId).toBe(TID);
        expect(result.tmuxSession).toBe(`vh-${TID}`);

        // The session really is 1-based (the precondition the bug needs).
        const panes = iso.run('list-panes', '-t', `=vh-${TID}:`, '-F', '#{window_index}.#{pane_index}').stdout.trim();
        expect(panes).toBe('1.1');
        expect(iso.run('capture-pane', '-p', '-t', `=vh-${TID}:.0`).status).not.toBe(0); // `.0` would still fail

        // Input goes to the right pane too (write path shares the target rule).
        mgr.write(TID, Buffer.from('printf pbi-marker-ok\r', 'utf8').toString('base64'));
        const deadline = Date.now() + 10_000;
        let seen = '';
        while (Date.now() < deadline) {
            seen = iso.run('capture-pane', '-p', '-t', `=vh-${TID}:`).stdout ?? '';
            if (seen.includes('pbi-marker-ok')) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        expect(seen).toContain('pbi-marker-ok');
    });
});
