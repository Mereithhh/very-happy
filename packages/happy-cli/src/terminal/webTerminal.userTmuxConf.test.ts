/**
 * B-270 regression: a user's ~/.tmux.conf must not break or degrade the web
 * terminal. Each scenario boots a fresh private tmux server (isolatedTmux)
 * whose config file carries one hostile setting (or all of them), then drives
 * the daemon path end to end: open → resize → write → last viewer leaves →
 * re-attach → shell exit. Before the per-session overrides in
 * tmuxNewSessionArgs, `destroy-unattached on` killed every open
 * (terminal-open-timeout), `window-size manual` froze the pane at 80x24,
 * `pane-border-status top` ate a row and `remain-on-exit on` left a dead pane.
 *
 * Config is injected through XDG_CONFIG_HOME/tmux/tmux.conf (tmux ≥3.1); the
 * spawned server reads it exactly like a user's dotfile. On builds that crash
 * while creating ANY session under window-size manual, assert PTY fallback
 * first, then apply that option to an existing session to test real recovery.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedTmux, tmuxAvailable } from '@/testing/isolatedTmux';

const happyHome = mkdtempSync(join(tmpdir(), 'vh-utc-home-'));
const prevHome = process.env.HAPPY_HOME_DIR;
process.env.HAPPY_HOME_DIR = happyHome;
const iso = createIsolatedTmux('vh-utc');
const { WebTerminalManager, tmuxNewSessionArgs, tmuxSupportsNewSessionEnv, CLAUDE_CLASSIC_RENDERER_ENV, resolveDefaultShell } = await import('./webTerminal');

const xdg = mkdtempSync(join(tmpdir(), 'vh-utc-xdg-'));
mkdirSync(join(xdg, 'tmux'), { recursive: true });
const prevXdg = process.env.XDG_CONFIG_HOME;

const SCENARIOS: Array<[label: string, conf: string]> = [
    ['destroy-unattached on', 'set -g destroy-unattached on'],
    ['remain-on-exit on', 'set -g remain-on-exit on'],
    ['window-size manual', 'set -g window-size manual'],
    ['pane-border-status top', 'set -g pane-border-status top'],
    ['base-index 1 / pane-base-index 1 (B-269)', 'set -g base-index 1\nsetw -g pane-base-index 1'],
    ['a whole dotfile', [
        'set -g mouse on', 'set -g prefix C-a', 'unbind C-b', 'bind C-a send-prefix',
        'set -g base-index 1', 'setw -g pane-base-index 1', 'set -g renumber-windows on',
        'set -g destroy-unattached on', 'set -g remain-on-exit on',
        // (`window-size manual` deliberately left out here — see the scenario
        // above: some tmux builds cannot create a session under it at all.)
        'set -g pane-border-status top', 'set -g status off', 'set -g default-terminal "screen-256color"',
        'set -sg escape-time 0', 'set -g history-limit 50000', 'setw -g mode-keys vi',
        'setw -g aggressive-resize on', 'set -g detach-on-destroy off', 'set -g exit-empty off',
        'set -g allow-rename off', 'setw -g automatic-rename off', 'bind -n C-h select-pane -L',
    ].join('\n')],
];

async function until(probe: () => boolean, ms = 12_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (probe()) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return false;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!tmuxAvailable)('web terminal vs user tmux.conf (B-270, real tmux)', () => {
    afterAll(() => {
        iso.dispose();
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
        if (prevHome === undefined) delete process.env.HAPPY_HOME_DIR; else process.env.HAPPY_HOME_DIR = prevHome;
        rmSync(happyHome, { recursive: true, force: true });
        rmSync(xdg, { recursive: true, force: true });
    });

    for (const [label, conf] of SCENARIOS) {
        it(`survives: ${label}`, async () => {
            writeFileSync(join(xdg, 'tmux', 'tmux.conf'), conf + '\n');
            process.env.XDG_CONFIG_HOME = xdg;
            iso.env.XDG_CONFIG_HOME = xdg;
            iso.killServer(); // next tmux call boots a fresh server with THIS config
            // Probe the SAME environment as the manager: isolatedTmux snapshots
            // env at creation, before this suite selects its per-test XDG config.
            const tmuxV = iso.run('-V').stdout.trim();
            const tid = 'utc' + Math.random().toString(16).slice(2, 9);
            const sess = `vh-${tid}`;
            let attachExisting = false;
            const envFlags = tmuxSupportsNewSessionEnv(tmuxV)
                ? ['-e', CLAUDE_CLASSIC_RENDERER_ENV, '-e', 'VH_TERMINAL_ID=utc-probe', '-e', `VH_HAPPY_HOME_DIR=${happyHome}`]
                : [];
            const probe = iso.run(...tmuxNewSessionArgs('utc-probe', 80, 24, iso.dir, envFlags, resolveDefaultShell(process.platform, process.env)));
            await sleep(500);
            // …and survives what open() does next: a control-mode client that
            // declares its size (`refresh-client -C`) — on CI's tmux 3.4 the
            // server dies exactly there under `window-size manual`.
            const attach = iso.spawn(['-C', 'attach-session', '-t', '=utc-probe:'], { input: 'refresh-client -C 100x30\ndetach-client\n', timeout: 5000 });
            await sleep(500);
            if (probe.status !== 0 || !iso.hasSession('utc-probe')) {
                expect(conf, `unexpected tmux startup failure: ${probe.stderr || attach.stderr}`).toBe('set -g window-size manual');
                iso.killServer();
                // Some tmux builds crash during new-session with window-size
                // manual. Exercise our real PTY fallback, then load the same
                // globals and window option AFTER creating a private session.
                // Recovery, resize and re-attach still run instead of skipping.
                const fallback = new WebTerminalManager(() => {});
                const fallbackId = 'utc-fallback';
                try {
                    const result = await fallback.open({ terminalId: fallbackId, cols: 80, rows: 24, cwd: iso.dir });
                    expect(result.tmuxSession, 'unsupported cold tmux start uses PTY').toBeUndefined();
                } finally {
                    fallback.killSession(fallbackId);
                    fallback.stopListTracking();
                }
                iso.killServer();
                expect(iso.run('-f', '/dev/null', 'new-session', '-d', '-s', 'utc-anchor', 'sleep 120').status).toBe(0);
                expect(iso.run(...tmuxNewSessionArgs(sess, 80, 24, iso.dir, [], resolveDefaultShell(process.platform, process.env))).status).toBe(0);
                attachExisting = true;
                expect(iso.run('source-file', join(xdg, 'tmux', 'tmux.conf')).status).toBe(0);
                expect(iso.run('set-option', '-w', '-t', `=${sess}:`, 'window-size', 'manual').status).toBe(0);
            }
            // Keep the probe/anchor alive: killing the final session would race
            // the asynchronous server shutdown against the next create.
            const mgr = new WebTerminalManager(() => { /* byte stream not under test */ });
            const geom = () => iso.run('display-message', '-p', '-t', `=${sess}:`, '#{pane_width}x#{pane_height}').stdout.trim();
            try {
                const r = await mgr.open({ terminalId: tid, cols: 80, rows: 24, cwd: iso.dir, attachOnly: attachExisting });
                expect(r.tmuxSession, `open() fell back (tmux ${tmuxV}); result=${JSON.stringify({ ...r, data: undefined, chunks: undefined })} sessions=[${iso.run('list-sessions', '-F', '#{session_name}').stdout.trim().replace(/\n/g, ',')}] stderr=${iso.run('list-sessions').stderr.trim()}`).toBe(sess);
                // The hostile global really is in force on this server…
                const firstOpt = conf.split('\n')[0].split(' ');
                expect(iso.run('show-options', '-gqv', firstOpt[2]).stdout.trim()).toBe(firstOpt.slice(3).join(' ').replace(/"/g, ''));
                // …but our session carries the overrides.
                expect(iso.run('show-options', '-qv', '-t', `=${sess}:`, 'destroy-unattached').stdout.trim()).toBe('off');
                expect(iso.run('show-options', '-wqv', '-t', `=${sess}:`, 'remain-on-exit').stdout.trim()).toBe('off');

                mgr.resize(tid, 100, 30);
                expect(await until(() => geom() === '100x30', 10_000), `resize followed (got ${geom()})`).toBe(true);

                mgr.write(tid, Buffer.from('printf utc-marker-ok\r', 'utf8').toString('base64'));
                expect(await until(() => (iso.run('capture-pane', '-p', '-t', `=${sess}:`).stdout ?? '').includes('utc-marker-ok')), 'write reached the pane').toBe(true);

                mgr.unsubscribe(tid); // last viewer leaves → control client stops
                await sleep(1200);
                expect(iso.hasSession(sess), 'session survives the last viewer leaving').toBe(true);

                const again = await mgr.open({ terminalId: tid, cols: 80, rows: 24, cwd: iso.dir, attachOnly: true });
                expect(again.tmuxSession).toBe(sess);

                mgr.write(tid, Buffer.from('exit\r', 'utf8').toString('base64'));
                expect(await until(() => !iso.hasSession(sess), 10_000), 'session goes away when the shell exits').toBe(true);
            } finally {
                try { mgr.killSession(tid); } catch { /* already gone */ }
                mgr.stopListTracking();
            }
        }, 60_000);
    }
});
