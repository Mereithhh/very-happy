/**
 * B-486: a machine WITHOUT tmux (Chuhui's SageMaker HyperPod image,
 * 2026-09-23). The web terminal opened as a direct pty and worked, but the
 * pushed list is tmux truth, so the row never reached any sidebar and the
 * optimistic create row expired after 60 s — "the terminal vanishes".
 *
 * tmux is made unfindable for this worker (PATH/HOME point at empty dirs)
 * BEFORE importing webTerminal: `configuration` is built at import time, and
 * a missing tmux is cached for 30 s before the next probe.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const happyHome = mkdtempSync(join(tmpdir(), 'vh-direct-home-'));
const fakeHome = mkdtempSync(join(tmpdir(), 'vh-direct-user-'));
const emptyBin = mkdtempSync(join(tmpdir(), 'vh-direct-bin-'));
const workDir = mkdtempSync(join(tmpdir(), 'vh-direct-work-'));
const saved = { HAPPY_HOME_DIR: process.env.HAPPY_HOME_DIR, PATH: process.env.PATH, HOME: process.env.HOME, SHELL: process.env.SHELL };
process.env.HAPPY_HOME_DIR = happyHome;
process.env.HOME = fakeHome;          // ptyEnv prepends ~/.local/bin
process.env.PATH = emptyBin;          // no tmux anywhere
process.env.SHELL = '/bin/sh';

const { WebTerminalManager, tmuxRuntimeInfo } = await import('./webTerminal');

describe.skipIf(process.platform === 'win32')('direct-pty terminals without tmux (B-486)', () => {
    const mgr = new WebTerminalManager(() => { /* stream not under test */ });

    afterAll(() => {
        mgr.disposeAll();
        mgr.stopListTracking();
        for (const d of [happyHome, fakeHome, emptyBin, workDir]) rmSync(d, { recursive: true, force: true });
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    });

    it('reports the machine as tmux-less', () => {
        expect(tmuxRuntimeInfo()).toEqual({ tmuxAvailable: false });
    });

    it('lists a direct shell so it cannot vanish from the sidebar', async () => {
        const res = await mgr.open({ terminalId: 'direct01', cwd: workDir, cols: 80, rows: 24 });
        expect(res.tmuxSession).toBeUndefined();
        const row = mgr.buildTerminalList().find((t) => t.id === 'direct01');
        expect(row).toMatchObject({ id: 'direct01', cwd: workDir, direct: true, tags: [] });
        expect(typeof row?.createdAt).toBe('number');
    });

    it('keeps a rename and tags in the daemon (no tmux options to store them)', () => {
        expect(mgr.setTitle('direct01', 'from-first-command', true)).toBe(true);
        expect(mgr.setTitle('direct01', 'data copy')).toBe(true);
        expect(mgr.setTitle('direct01', 'auto again', true)).toBe(true); // ifAbsent never beats a rename
        expect(mgr.setTags('direct01', ['gpu'])).toBe(true);
        expect(mgr.buildTerminalList().find((t) => t.id === 'direct01')).toMatchObject({ title: 'data copy', manual: true, tags: ['gpu'] });
    });

    it('is not reaped when unwatched — reaping would kill the shell', async () => {
        await mgr.open({ terminalId: 'direct02', cwd: workDir, cols: 80, rows: 24 });
        const session = (mgr as any).terminals.get('direct02');
        session.subscribers = 0;
        session.lastTouch = 0;
        (mgr as any).reapIdle();
        expect(mgr.buildTerminalList().map((t) => t.id)).toContain('direct02');
    });

    it('closes from the sidebar without tmux and leaves a close record', () => {
        expect(mgr.killSession('direct01')).toBe(true);
        expect(mgr.buildTerminalList().map((t) => t.id)).not.toContain('direct01');
        expect(mgr.getClosedTerminals().find((r) => r.id === 'direct01')).toMatchObject({ cwd: workDir, reason: 'closed' });
    });

    // Last: it puts a (fake) tmux on PATH for the rest of this worker.
    it('notices a tmux installed after startup without a daemon restart', () => {
        const fake = join(emptyBin, 'tmux');
        writeFileSync(fake, '#!/bin/sh\n[ "$1" = "-V" ] && echo "tmux 3.4"\nexit 0\n');
        chmodSync(fake, 0o755);
        expect(tmuxRuntimeInfo()).toEqual({ tmuxAvailable: false }); // still inside the negative-cache window
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(Date.now() + 31_000);
            expect(tmuxRuntimeInfo()).toEqual({ tmuxAvailable: true, tmuxVersion: 'tmux 3.4' });
        } finally {
            vi.useRealTimers();
        }
    });
});
