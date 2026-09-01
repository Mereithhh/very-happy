/**
 * B-273 end-to-end on a REAL tmux server (private socket via
 * src/testing/isolatedTmux.ts, isolated HAPPY_HOME_DIR): a user session is
 * listed (vh-* is not), opening with `attachTmux` types the attach line into
 * a fresh vh pane so the user's session renders inside it, keystrokes reach
 * the user's pane, closing the web terminal leaves the user's session alone,
 * a bad target refuses WITHOUT creating a vh session, and a closed attach
 * terminal restores attached (or refuses when the session is gone).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedTmux, tmuxAvailable } from '@/testing/isolatedTmux';

const happyHome = mkdtempSync(join(tmpdir(), 'vh-att-home-'));
const prevHome = process.env.HAPPY_HOME_DIR;
process.env.HAPPY_HOME_DIR = happyHome;
const iso = createIsolatedTmux('vh-att');
const { WebTerminalManager } = await import('./webTerminal');
const { USER_SESSIONS_FORMAT } = await import('./userTmuxSessions');

const USER = 'my dev';
async function until(probe: () => boolean, ms = 10_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (probe()) return true; await new Promise((r) => setTimeout(r, 100)); }
    return false;
}
const capture = (target: string) => iso.run('capture-pane', '-p', '-t', target).stdout ?? '';
const clients = () => (iso.run('list-clients', '-F', '#{client_session}').stdout ?? '').split('\n').filter(Boolean);

describe.skipIf(!tmuxAvailable)('attach an existing tmux session (B-273, real tmux)', () => {
    const mgr = new WebTerminalManager(() => { /* byte stream not under test */ });
    afterAll(() => {
        mgr.stopListTracking();
        iso.dispose();
        if (prevHome === undefined) delete process.env.HAPPY_HOME_DIR; else process.env.HAPPY_HOME_DIR = prevHome;
        rmSync(happyHome, { recursive: true, force: true });
    });

    it('lists user sessions (not vh-*), attaches inside a fresh vh pane, keys reach the inner pane, close keeps the user session', async () => {
        expect(iso.run('new-session', '-d', '-s', USER, '-x', '80', '-y', '24', '-c', iso.dir, '/bin/sh').status).toBe(0);
        iso.run('new-window', '-t', `=${USER}:`, '/bin/sh');
        iso.run('send-keys', '-t', `=${USER}:`, '-l', '--', 'printf INNER-MARK\r');
        expect(await until(() => capture(`=${USER}:`).includes('INNER-MARK'))).toBe(true);
        expect(iso.run('new-session', '-d', '-s', 'vh-decoy', '/bin/sh').status).toBe(0);

        const list = mgr.listUserTmuxSessions();
        const raw = iso.run('list-sessions', '-F', USER_SESSIONS_FORMAT);
        expect(list.map((s) => s.name), `diagnostics: socket=${process.env.VH_TMUX_SOCKET} probe=${JSON.stringify(mgr.lastUserSessionsProbe)} raw=${JSON.stringify({ status: raw.status, stderr: raw.stderr?.trim(), stdout: raw.stdout }, null, 0)}`).toEqual([USER]);
        const target = list[0];
        expect(target.id).toMatch(/^\$\d+$/);
        expect(target.windows).toBe(2);

        const r = await mgr.open({ terminalId: 'att00000001', cols: 100, rows: 30, cwd: iso.dir, attachTmux: { id: target.id, name: USER } });
        expect(r.tmuxSession).toBe('vh-att00000001');
        expect(r.attachedTmux).toEqual({ id: target.id, name: USER });
        // The inner session renders inside the vh pane.
        expect(await until(() => capture('=vh-att00000001:').includes('INNER-MARK'))).toBe(true);
        expect(await until(() => clients().includes(USER))).toBe(true);
        // Title pinned to the session name, marker stored, list item carries it.
        expect(iso.run('show-options', '-qv', '-t', '=vh-att00000001:', '@vh_title').stdout.trim()).toBe(USER);
        expect(iso.run('show-options', '-qv', '-t', '=vh-att00000001:', '@vh_attach').stdout.trim()).toBe(USER);
        const item = mgr.listSessions().find((t) => t.id === 'att00000001');
        expect(item).toMatchObject({ title: USER, manual: true, attachTmux: USER });
        // A repeated create-open of the LIVE session still echoes the attach fact
        // (StrictMode double effect / lost reply replayed with fresh=1).
        const again = await mgr.open({ terminalId: 'att00000001', cols: 100, rows: 30, cwd: iso.dir, attachTmux: { id: target.id, name: USER } });
        expect(again.attachedTmux).toEqual({ id: target.id, name: USER });
        mgr.unsubscribe('att00000001');
        // The live snapshot on disk carries the target (daemon-gap restore needs it).
        mgr.startListTracking(() => { /* pushes not under test */ }, 10 * 60 * 1000);
        mgr.requestListRefresh(); // tracking ticks on kicks, not on start
        expect(await until(() => {
            try { return JSON.parse(readFileSync(join(happyHome, 'live-terminals.json'), 'utf8'))?.att00000001?.attachTmux === USER; } catch { return false; }
        })).toBe(true);
        mgr.stopListTracking();
        // Keys typed into the web terminal land in the USER's pane.
        mgr.write('att00000001', Buffer.from('printf NESTED-KEYS-OK\r', 'utf8').toString('base64'));
        expect(await until(() => capture(`=${USER}:`).includes('NESTED-KEYS-OK'))).toBe(true);
        // Closing the web terminal only drops the inner client.
        expect(mgr.killSession('att00000001')).toBe(true);
        expect(await until(() => !clients().includes(USER))).toBe(true);
        expect(iso.hasSession(USER)).toBe(true);
        expect(iso.run('list-windows', '-t', `=${USER}:`).stdout.trim().split('\n')).toHaveLength(2);
        // …and the close record remembers the target for restore.
        expect(mgr.getClosedTerminals().find((c) => c.id === 'att00000001')).toMatchObject({ attachTmux: USER, manual: true });
    }, 40_000);

    it('a stale id, a foreign name, or a vh-* target is refused before anything is created', async () => {
        const live = mgr.listUserTmuxSessions().find((s) => s.name === USER)!;
        await expect(mgr.open({ terminalId: 'att00000002', cols: 80, rows: 24, attachTmux: { id: live.id, name: 'not the same' } })).rejects.toThrow('tmux-session-gone');
        await expect(mgr.open({ terminalId: 'att00000003', cols: 80, rows: 24, attachTmux: { id: '$999999', name: USER } })).rejects.toThrow('tmux-session-gone');
        await expect(mgr.open({ terminalId: 'att00000004', cols: 80, rows: 24, attachTmux: { id: live.id, name: 'vh-decoy' } })).rejects.toThrow('tmux-session-gone');
        for (const id of ['att00000002', 'att00000003', 'att00000004']) expect(iso.hasSession(`vh-${id}`)).toBe(false);
    });

    it('restore re-attaches while the session lives, refuses once it is gone', async () => {
        expect(mgr.restoreClosedTerminal('att00000001')).toEqual({ type: 'success', terminalId: 'att00000001' });
        expect(await until(() => clients().includes(USER))).toBe(true);
        expect(iso.run('show-options', '-qv', '-t', '=vh-att00000001:', '@vh_attach').stdout.trim()).toBe(USER);
        expect(mgr.killSession('att00000001')).toBe(true);
        expect(await until(() => !clients().includes(USER))).toBe(true);
        iso.run('kill-session', '-t', `=${USER}:`);
        expect(mgr.restoreClosedTerminal('att00000001')).toEqual({ type: 'error', reason: 'tmux-session-gone' });
        expect(iso.hasSession('vh-att00000001')).toBe(false);
    }, 30_000);
});
