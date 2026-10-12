/**
 * B-547 end to end on the daemon side, against a REAL tmux server (private
 * socket via src/testing/isolatedTmux.ts) and an isolated HAPPY_HOME_DIR —
 * both set before importing webTerminal (`configuration` is an import-time
 * singleton).
 *
 * A fake `claude` (node script, so the process-tree identity resolves to
 * claude exactly like the real npm/native launchers) answers `--version`
 * with the repo-locked 2.1.296 and otherwise shows Claude's idle footer.
 * Hook events are delivered through the same entry point the control server
 * uses (`ingestAgentHook`); the forwarder script has its own test.
 *
 * Asserted: the daemon-typed `claude` startup command carries `--settings`
 * with a settings file in the isolated home; a hook `working` beats a screen
 * that shows an idle prompt and pushes WITHOUT waiting for the 10 s tick;
 * Esc during a confirmed turn + idle screen is inferred as done (Stop never
 * fires on interrupt) and notifies immediately; SessionEnd falls back to the
 * screen; killing the terminal removes its settings file.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedTmux, tmuxAvailable } from '@/testing/isolatedTmux';

const happyHome = mkdtempSync(join(tmpdir(), 'vh-hooks-home-'));
const iso = createIsolatedTmux('vh-hooks-tmux');
const binDir = mkdtempSync(join(tmpdir(), 'vh-hooks-bin-'));
const saved = { home: process.env.HAPPY_HOME_DIR, path: process.env.PATH, shell: process.env.SHELL };
process.env.HAPPY_HOME_DIR = happyHome;
// A plain sh without rc files: the user's zsh rc would put the REAL claude
// (~/.local/bin) in front of the fake one.
process.env.SHELL = '/bin/sh';
const fakeClaude = join(binDir, 'claude');
writeFileSync(fakeClaude, [
    '#!/usr/bin/env node',
    "if (process.argv.includes('--version')) { console.log('2.1.296 (Claude Code)'); process.exit(0); }",
    "process.stdout.write('\\n  ? for shortcuts\\n');",
    'setInterval(() => {}, 1 << 30);',
    '',
].join('\n'));
chmodSync(fakeClaude, 0o755);
process.env.PATH = `${binDir}:${saved.path ?? ''}`;

const { WebTerminalManager } = await import('./webTerminal');
const { terminalHookSettingsPath } = await import('./terminalHookSettings');

type Item = { id: string; agentState?: string; agentKind?: string };

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs: number, label: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = probe();
        if (v) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 100));
    }
}

describe.skipIf(!tmuxAvailable)('web terminal hook status (B-547, real tmux)', () => {
    const TID = 'hookst01';
    const pushes: Item[][] = [];
    const notified: string[] = [];
    const mgr = new WebTerminalManager(() => { /* byte stream not under test */ }, (n) => notified.push(n.event));
    const latest = () => pushes.length ? pushes[pushes.length - 1].find((t) => t.id === TID) : undefined;
    const hook = (event: string, extra: Record<string, unknown> = {}) => mgr.ingestAgentHook({
        hook_event_name: event, session_id: 'sess-hook-1', terminalId: TID, claudePid: process.pid, ...extra,
    });

    afterAll(() => {
        mgr.stopListTracking();
        iso.run('kill-session', '-t', `=vh-${TID}:`);
        iso.dispose();
        for (const d of [happyHome, binDir]) rmSync(d, { recursive: true, force: true });
        for (const [k, v] of [['HAPPY_HOME_DIR', saved.home], ['PATH', saved.path], ['SHELL', saved.shell]] as const) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    });

    it('injects --settings into the daemon-typed claude command', { timeout: 30_000 }, async () => {
        // Tick interval far beyond the test: every push below is event-kicked.
        mgr.startListTracking((list) => pushes.push(list as Item[]), 10 * 60 * 1000);
        // The version probe starts with tracking; give it a moment to land.
        const settingsPath = terminalHookSettingsPath(TID);
        await new Promise((r) => setTimeout(r, 1500));
        await mgr.open({ terminalId: TID, cols: 100, rows: 30, cwd: binDir, startupCommand: 'claude' });
        expect(existsSync(settingsPath)).toBe(true);
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        expect(Object.keys(settings.hooks)).toEqual(expect.arrayContaining(['UserPromptSubmit', 'Stop', 'PermissionRequest', 'SessionEnd']));
        await expect.poll(() => iso.run('capture-pane', '-p', '-J', '-S', '-', '-t', `=vh-${TID}:`).stdout, { timeout: 8000 })
            .toContain(`claude --settings '${settingsPath}'`);
        // The fake claude is up and shows its idle footer.
        await expect.poll(() => iso.run('capture-pane', '-p', '-t', `=vh-${TID}:`).stdout, { timeout: 8000 })
            .toContain('? for shortcuts');
    });

    it('a hook working beats an idle-looking screen and pushes via the kick', async () => {
        // Settle the screen baseline (claude, idle) through a kick.
        mgr.requestListRefresh();
        await waitFor(() => latest()?.agentKind === 'claude' && latest()?.agentState === 'idle', 8000, 'screen idle baseline');
        hook('SessionStart', { source: 'startup' });
        hook('UserPromptSubmit', { prompt_id: 'p-1' });
        await waitFor(() => latest()?.agentState === 'working', 3000, 'hook working push');
    });

    it('Esc during the turn is inferred as done once the screen confirms idle', async () => {
        const before = notified.length;
        mgr.write(TID, Buffer.from('\x1b', 'utf8').toString('base64'));
        await waitFor(() => latest()?.agentState === 'idle', 6000, 'inferred interrupt push');
        // Hook-sourced transition → no 2-tick debounce.
        expect(notified.slice(before)).toContain('completed');
    });

    it('permission dialog, approval, a dialog answered with Enter, Stop, SessionEnd', { timeout: 30_000 }, async () => {
        hook('UserPromptSubmit', { prompt_id: 'p-2' });
        await waitFor(() => latest()?.agentState === 'working', 3000, 'second turn working');
        hook('PermissionRequest', { tool_name: 'Bash' });
        // The fake screen still shows an idle footer: the hook's needs_input holds.
        await waitFor(() => latest()?.agentState === 'needs_input', 3000, 'permission push');
        hook('PostToolUse', { tool_name: 'Bash' });
        await waitFor(() => latest()?.agentState === 'working', 3000, 'approved → working');
        hook('PermissionRequest', { tool_name: 'Bash' });
        await waitFor(() => latest()?.agentState === 'needs_input', 3000, 'second permission push');
        // Enter on "No" ends the turn without any hook; the idle screen confirms.
        mgr.write(TID, Buffer.from('\r', 'utf8').toString('base64'));
        await waitFor(() => latest()?.agentState === 'idle', 6000, 'dialog answered → idle');
        hook('UserPromptSubmit', { prompt_id: 'p-2b' });
        await waitFor(() => latest()?.agentState === 'working', 3000, 'next turn working');
        hook('Stop');
        await waitFor(() => latest()?.agentState === 'idle', 3000, 'stop → idle');
        hook('UserPromptSubmit', { prompt_id: 'p-3' });
        await waitFor(() => latest()?.agentState === 'working', 3000, 'third turn working');
        hook('SessionEnd', { reason: 'exit' });
        // Record gone → the screen (idle footer) decides again.
        await waitFor(() => latest()?.agentState === 'idle', 3000, 'screen fallback after SessionEnd');
    });

    it('killing the terminal removes its settings file', () => {
        expect(mgr.killSession(TID)).toBe(true);
        expect(existsSync(terminalHookSettingsPath(TID))).toBe(false);
    });
});
