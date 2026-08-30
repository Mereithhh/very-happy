/**
 * Guard for the 2026-08-31 incident (00:42 / 01:35): the tmux test suites
 * killed every vh-* web terminal on mac-office because their isolation relied
 * on TMUX_TMPDIR, which a tmux client ignores when an inherited `$TMUX` names
 * another socket. This file plays the "real" daemon server with a fake socket
 * in `$TMUX`, drives the same manager paths the suites use (open, kill,
 * kill-server) through the isolated helper, and asserts the fake real server
 * was neither populated nor killed. It also forbids any bare `kill-server` in
 * the test tree.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createIsolatedTmux, tmuxAvailable } from '@/testing/isolatedTmux';
import { scrubTmuxClientEnv, tmuxArgs, VH_TMUX_SOCKET_ENV } from './tmuxSocket';

const REAL_SESSION = 'vh-guardreal1';

describe('tmuxSocket helpers', () => {
    it('prefixes -S only when VH_TMUX_SOCKET is set', () => {
        expect(tmuxArgs(['ls'], {})).toEqual(['ls']);
        expect(tmuxArgs(['ls'], { [VH_TMUX_SOCKET_ENV]: '/tmp/x/sock' })).toEqual(['-S', '/tmp/x/sock', 'ls']);
    });

    it('scrubs the inherited client variables', () => {
        const env = scrubTmuxClientEnv({ TMUX: '/tmp/real,1,0', TMUX_PANE: '%1', PATH: '/bin' });
        expect(env).toEqual({ PATH: '/bin' });
    });
});

describe('no bare kill-server in the test tree', () => {
    it('every kill-server is socket-bound via isolatedTmux', () => {
        const root = join(__dirname, '..');
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const p = join(dir, name);
                if (statSync(p).isDirectory()) { walk(p); continue; }
                if (!/\.test\.ts$/.test(name) || p === __filename) continue;
                const src = readFileSync(p, 'utf8');
                for (const line of src.split('\n')) {
                    // Allowed: prose in comments / strings under test (`isSafeControlCommand`),
                    // and this guard file. Forbidden: an actual argv containing kill-server.
                    if (/\[\s*'kill-server'|tmux\('kill-server'\)|spawn\(\['kill-server'\]/.test(line)) offenders.push(`${p}: ${line.trim()}`);
                }
            }
        };
        walk(root);
        expect(offenders).toEqual([]);
        // The helper itself is the single owner and always passes -S.
        const helper = readFileSync(join(root, 'testing', 'isolatedTmux.ts'), 'utf8');
        expect(helper).toMatch(/spawnSync\('tmux', \['-S', socket, \.\.\.args\]/);
    });
});

describe.skipIf(!tmuxAvailable)('isolated suites never touch the server named by $TMUX', () => {
    let realDir: string;
    let realSocket: string;
    let savedTmux: string | undefined;
    const real = (...args: string[]) => spawnSync('tmux', ['-S', realSocket, ...args], { encoding: 'utf8', env: scrubTmuxClientEnv({ ...process.env }) });

    beforeAll(() => {
        realDir = mkdtempSync(join(tmpdir(), 'vh-guard-real-'));
        realSocket = join(realDir, 'sock');
        expect(real('new-session', '-d', '-s', REAL_SESSION, '-x', '80', '-y', '24').status).toBe(0);
        savedTmux = process.env.TMUX;
        // What a web terminal hands to a test run: the client would follow this.
        process.env.TMUX = `${realSocket},${process.pid},0`;
    });

    afterAll(() => {
        real('kill-server');
        rmSync(realDir, { recursive: true, force: true });
        if (savedTmux === undefined) delete process.env.TMUX; else process.env.TMUX = savedTmux;
    });

    it('open + kill + kill-server through the isolated helper leave the real server intact', async () => {
        const iso = createIsolatedTmux('vh-guard-iso');
        const happyHome = mkdtempSync(join(tmpdir(), 'vh-guard-home-'));
        const prevHome = process.env.HAPPY_HOME_DIR;
        process.env.HAPPY_HOME_DIR = happyHome;
        mkdirSync(happyHome, { recursive: true });
        writeFileSync(join(happyHome, 'settings.json'), JSON.stringify({ schemaVersion: 2, onboardingCompleted: true, terminalAutoRestore: false }));
        try {
            // The manager reads VH_TMUX_SOCKET lazily, so importing after the
            // helper is set up mirrors the suites' order.
            const { WebTerminalManager } = await import('./webTerminal');
            const mgr = new WebTerminalManager(() => { /* stream not under test */ });
            const id = 'guardiso1';
            await mgr.open({ terminalId: id, cols: 80, rows: 24 });
            expect(iso.hasSession(`vh-${id}`)).toBe(true);
            expect(real('has-session', '-t', `=vh-${id}:`).status).not.toBe(0);
            mgr.killSession(id);
            expect(iso.hasSession(`vh-${id}`)).toBe(false);
            mgr.disposeAll?.();
            iso.killServer();
        } finally {
            iso.dispose();
            rmSync(happyHome, { recursive: true, force: true });
            if (prevHome === undefined) delete process.env.HAPPY_HOME_DIR; else process.env.HAPPY_HOME_DIR = prevHome;
        }
        // The fake "real" server is still up with exactly its own session.
        expect(real('list-sessions', '-F', '#{session_name}').stdout.trim().split('\n')).toEqual([REAL_SESSION]);
    });
});
