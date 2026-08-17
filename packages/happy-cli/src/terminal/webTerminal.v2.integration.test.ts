/**
 * B-121 terminal channel v2 — end-to-end against a REAL tmux server, isolated
 * via TMUX_TMPDIR (same discipline as webTerminal.tracker.integration.test.ts:
 * the user's own sessions are never touched).
 *
 * What this file pins down is the DAEMON CONTRACT the web depends on:
 *   open(streamMode:'lines')  → shallow screen inline + snapshotId for the deep
 *                               history + alternateOn, seq baseline
 *   terminal-output           → the pane's real bytes (control-mode %output),
 *                               NOT a tmux-painted mirror
 *   getHistoryPage()          → the deep history, paged, byte-exact
 *   write()                   → send-keys three-channel encoding (ASCII / code
 *                               points / C0), the pane must receive exactly the
 *                               bytes the browser sent
 *   paste()                   → tmux buffer paste (bracketed when the app asked
 *                               for it) — multi-line text must NOT execute line
 *                               by line
 *   open() without streamMode → the v1 shape, verbatim (old web / old app)
 *
 * These are integration tests on purpose: every one of them has failed in a
 * pure unit mock at some point in this repo's history while the real tmux
 * behaved differently.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WebTerminalManager, type OpenTerminalResult } from './webTerminal';

/** Narrow an open result to its snapshot form (every lines-mode open here is
 *  expected to be one — a replay would mean the assertion below is testing the
 *  wrong path, so failing loudly is the point). */
function snapshot(res: OpenTerminalResult): Extract<OpenTerminalResult, { mode: 'snapshot' }> {
    if (res.mode !== 'snapshot') throw new Error(`expected a snapshot response, got ${res.mode}`);
    return res;
}

const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 15_000, label = 'condition'): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = probe();
        if (v) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 50));
    }
}

describe.skipIf(!tmuxAvailable)('terminal channel v2 (real tmux control mode, isolated server)', () => {
    let dir: string;
    let savedTmpdir: string | undefined;
    let mgr: WebTerminalManager;
    /** Every terminal-output frame, decoded to bytes. */
    const out = new Map<string, Buffer[]>();
    const seen = (id: string) => Buffer.concat(out.get(id) ?? []).toString('utf8');
    /** Listeners for `terminal-exit` (registered per test that cares). */
    const exitSink: Array<(payload: { terminalId: string; exitCode: number }) => void> = [];

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'vh-v2-'));
        savedTmpdir = process.env.TMUX_TMPDIR;
        process.env.TMUX_TMPDIR = dir;
        mgr = new WebTerminalManager((event, payload) => {
            if (event === 'terminal-exit') {
                for (const cb of exitSink) cb(payload);
                return;
            }
            if (event !== 'terminal-output') return;
            const list = out.get(payload.terminalId) ?? [];
            list.push(Buffer.from(payload.data, 'base64'));
            out.set(payload.terminalId, list);
        });
    });

    afterAll(() => {
        mgr?.stopListTracking();
        mgr?.disposeAll?.();
        spawnSync('tmux', ['kill-server'], { stdio: 'ignore', env: { ...process.env, TMUX_TMPDIR: dir } as any });
        if (savedTmpdir === undefined) delete process.env.TMUX_TMPDIR;
        else process.env.TMUX_TMPDIR = savedTmpdir;
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    it('opens in lines mode: shallow screen inline + a snapshot id for the deep history', async () => {
        const id = 'v2open1';
        const res = await mgr.open({ terminalId: id, cols: 80, rows: 24, streamMode: 'lines' });
        expect(res.streamMode).toBe('lines');
        expect(res.mode).toBe('snapshot');
        expect(res.tmuxSession).toBe(`vh-${id}`);
        expect(typeof res.snapshotId).toBe('string');
        expect(res.alternateOn).toBe(false);
        // A fresh shell has a prompt — the shallow screen is never "nothing at
        // all" (the retired blank-screen belt used to guess at exactly this).
        await waitFor(() => seen(id).length > 0, 15_000, 'first live output');
    });

    it('streams the pane\'s real bytes (content flow, not a full-screen mirror)', async () => {
        const id = 'v2flow1';
        await mgr.open({ terminalId: id, cols: 80, rows: 24, streamMode: 'lines' });
        mgr.write(id, Buffer.from('echo v2-marker-中文\r', 'utf8').toString('base64'));
        await waitFor(() => seen(id).includes('v2-marker-中文'), 15_000, 'echoed marker');
        // No alternate-screen switch anywhere: a lines-mode session must never
        // put the browser into the alt buffer just because tmux attached.
        expect(seen(id)).not.toContain('\x1b[?1049h');
    });

    it('write() round-trips ASCII, CJK code points and C0 bytes into the pane', async () => {
        const id = 'v2write1';
        await mgr.open({ terminalId: id, cols: 80, rows: 24, streamMode: 'lines' });
        // cat with no redirection echoes what the tty receives; Ctrl-D ends it.
        mgr.write(id, Buffer.from('cat\r', 'utf8').toString('base64'));
        await waitFor(() => seen(id).includes('cat'), 15_000, 'cat started');
        const payload = 'ascii中文🙂';
        mgr.write(id, Buffer.from(`${payload}\r`, 'utf8').toString('base64'));
        await waitFor(() => seen(id).split(payload).length >= 3, 15_000, 'cat echoed the payload back');
        mgr.write(id, Buffer.from('\x04', 'utf8').toString('base64')); // C0: EOT
        await waitFor(() => !seen(id).endsWith(payload), 5_000, 'cat exited');
    });

    it('serves the deep history in byte-exact pages', async () => {
        const id = 'v2hist1';
        await mgr.open({ terminalId: id, cols: 80, rows: 24, streamMode: 'lines' });
        mgr.write(id, Buffer.from('for i in $(seq 1 200); do echo "histline-$i"; done\r', 'utf8').toString('base64'));
        await waitFor(() => seen(id).includes('histline-200'), 20_000, 'history generated');
        const res = await mgr.open({ terminalId: id, cols: 80, rows: 24, streamMode: 'lines', resub: true, attachOnly: true });
        expect(res.totalPages).toBeGreaterThan(0);
        const parts: Buffer[] = [];
        for (let p = 0; p < res.totalPages!; p++) {
            const page = mgr.getHistoryPage(id, res.snapshotId!, p);
            expect('data' in page).toBe(true);
            parts.push(Buffer.from((page as { data: string }).data, 'base64'));
        }
        const history = Buffer.concat(parts).toString('utf8');
        // The scrollback the browser could not have kept: early lines that
        // scrolled off the 24-row screen long ago.
        expect(history).toContain('histline-1\r\n');
        expect(history).toContain('histline-200');
    });

    it('rejects a stale snapshot id instead of serving mismatched pages', async () => {
        const id = 'v2hist2';
        const first = await mgr.open({ terminalId: id, cols: 80, rows: 24, streamMode: 'lines' });
        const second = await mgr.open({ terminalId: id, cols: 80, rows: 24, streamMode: 'lines', resub: true, attachOnly: true });
        expect(second.snapshotId).not.toBe(first.snapshotId);
        expect(mgr.getHistoryPage(id, first.snapshotId!, 0)).toEqual({ expired: true });
    });

    it('concurrent catch-ups share ONE capture — same instant, same snapshot id', async () => {
        const id = 'v2race1';
        await mgr.open({ terminalId: id, cols: 80, rows: 24, streamMode: 'lines' });
        mgr.write(id, Buffer.from('echo race-marker\r', 'utf8').toString('base64'));
        await waitFor(() => seen(id).includes('race-marker'), 15_000, 'output before the race');
        // Two viewers (phone + desktop) catch up at the same moment.
        const [a, b] = await Promise.all([
            mgr.open({ terminalId: id, cols: 80, rows: 24, streamMode: 'lines', resub: true, attachOnly: true }),
            mgr.open({ terminalId: id, cols: 80, rows: 24, streamMode: 'lines', resub: true, attachOnly: true }),
        ]);
        // Single-flight: one capture, one held snapshot, one baseline. Minting a
        // handle per caller would have expired the first viewer's id instantly.
        expect(a.snapshotId).toBe(b.snapshotId);
        expect(a.seq).toBe(b.seq);
        expect(a.totalPages).toBe(b.totalPages);
        const page = mgr.getHistoryPage(id, a.snapshotId!, 0);
        expect('data' in page).toBe(true);
    });

    it('an alt-screen pane restores as scrollback + alt frame, never polluting the scrollback', async () => {
        const id = 'v2alt1';
        await mgr.open({ terminalId: id, cols: 80, rows: 24, streamMode: 'lines' });
        mgr.write(id, Buffer.from('echo before-alt-marker\r', 'utf8').toString('base64'));
        await waitFor(() => seen(id).includes('before-alt-marker'), 15_000, 'pre-alt output');
        mgr.write(id, Buffer.from('seq 1 300 | less\r', 'utf8').toString('base64'));
        await waitFor(() => seen(id).includes('\x1b[?1049h'), 15_000, 'less entered the alt screen');
        const res = await mgr.open({ terminalId: id, cols: 80, rows: 24, streamMode: 'lines', resub: true, attachOnly: true });
        expect(res.alternateOn).toBe(true);
        const small = Buffer.from(snapshot(res).data, 'base64').toString('utf8');
        expect(small.startsWith('\x1b[?1049h')).toBe(true);
        const parts: Buffer[] = [];
        for (let p = 0; p < res.totalPages!; p++) {
            const page = mgr.getHistoryPage(id, res.snapshotId!, p) as { data: string };
            parts.push(Buffer.from(page.data, 'base64'));
        }
        const full = Buffer.concat(parts).toString('utf8');
        const altAt = full.indexOf('\x1b[?1049h');
        expect(altAt).toBeGreaterThan(-1);
        // The命门: the pre-alt transcript is in the scrollback part, and less's
        // frame is after the alt switch.
        expect(full.indexOf('before-alt-marker')).toBeGreaterThan(-1);
        expect(full.indexOf('before-alt-marker')).toBeLessThan(altAt);
        mgr.write(id, Buffer.from('q', 'utf8').toString('base64'));
    });

    it('paste() delivers multi-line text as ONE paste (no line-by-line execution)', async () => {
        const id = 'v2paste1';
        await mgr.open({ terminalId: id, cols: 80, rows: 24, streamMode: 'lines' });
        mgr.write(id, Buffer.from('cat\r', 'utf8').toString('base64'));
        await waitFor(() => seen(id).includes('cat'), 15_000, 'cat started');
        const before = seen(id).length;
        await mgr.paste(id, 'line-one\nline-two\nline-three');
        await waitFor(() => seen(id).slice(before).includes('line-three'), 15_000, 'pasted text reached the pane');
        // `cat` echoes; nothing may have run as a command (no shell error, no
        // "command not found").
        expect(seen(id)).not.toContain('command not found');
        mgr.write(id, Buffer.from('\x04', 'utf8').toString('base64'));
    });

    it('an old web (no streamMode) still gets the v1 open shape', async () => {
        const id = 'v2compat1';
        const res = await mgr.open({ terminalId: id, cols: 80, rows: 24 });
        expect(res.streamMode).toBeUndefined();
        expect(res.mode).toBe('snapshot');
        expect(typeof snapshot(res).data).toBe('string');
        // The fields only a lines-mode client knows how to use must be absent —
        // the old `applyOpenResult` throws on an unexpected shape.
        expect((res as Record<string, unknown>).snapshotId).toBeUndefined();
        expect((res as Record<string, unknown>).totalPages).toBeUndefined();
    });

    it('the shell exiting on its own ends the terminal (control client follows the session down)', async () => {
        const id = 'v2exit1';
        const exits: Array<{ terminalId: string; exitCode: number }> = [];
        exitSink.push((p) => exits.push(p));
        await mgr.open({ terminalId: id, cols: 80, rows: 24, streamMode: 'lines' });
        await waitFor(() => seen(id).length > 0, 15_000, 'session live');
        // The user types `exit` — tmux tears the session down, which drops our
        // control client. v1 learned this from the pty's exit; v2 has to learn
        // it from the child ending, or the terminal would linger as a live row
        // that answers nothing.
        mgr.write(id, Buffer.from('exit\r', 'utf8').toString('base64'));
        await waitFor(() => exits.some((e) => e.terminalId === id), 15_000, 'terminal-exit event');
        await waitFor(
            () => spawnSync('tmux', ['has-session', '-t', `=vh-${id}:`], { stdio: 'ignore' }).status !== 0,
            10_000,
            'tmux session gone',
        );
    });

    it('opening an EXISTING terminal at a new size reports the size that will actually apply', async () => {
        // Production 2026-08-17: opening an OLD terminal (one another device had
        // sized) rendered misaligned — input box drawn at the top while the
        // cursor sat at the bottom. Two bugs covered for each other:
        //  1. the reported geometry came from `list-panes`, which runs EARLIER
        //     in the capture batch than the closing `refresh-client -C`, so the
        //     client adopted the size the PREVIOUS device had left behind;
        //  2. the `%layout-change` that our own refresh triggers was deduped
        //     against "the size we asked for" — i.e. exactly itself — so the
        //     correcting announcement never went out and the client stayed
        //     wrong forever.
        const id = 'v2geom2';
        await mgr.open({ terminalId: id, cols: 120, rows: 40, streamMode: 'lines' });
        mgr.unsubscribe(id);
        // A different device opens the same terminal with its own viewport.
        const res = await mgr.open({ terminalId: id, cols: 70, rows: 20, streamMode: 'lines', attachOnly: true });
        expect(res.paneCols).toBe(70);
        expect(res.paneRows).toBe(20);
        // …and tmux really is at that size, so the live bytes match what the
        // client was told to render at.
        await waitFor(() => {
            const r = spawnSync('tmux', ['display', '-p', '-t', `=vh-${id}:`, '#{pane_width}x#{pane_height}'], { encoding: 'utf8' });
            return (r.stdout || '').trim() === '70x20';
        }, 10_000, 'pane resized to the opening client size');
    });

    it('an external resize is announced IN-BAND, in stream order (B-124 duplicate-status-line regression)', async () => {
        // The client wraps lines itself, so it must switch width exactly where
        // the pane did — an out-of-band event cannot express that ordering, and
        // getting it wrong is what leaves a second copy of a TUI's status line
        // on screen (measured: one real Claude stream captured at 100 columns
        // renders one footer at 100 and TWO at 80).
        const id = 'v2geom1';
        const res = await mgr.open({ terminalId: id, cols: 100, rows: 30, streamMode: 'lines' });
        expect(res.paneCols).toBe(100);
        expect(res.paneRows).toBe(30);
        mgr.write(id, Buffer.from('echo before-resize-marker\r', 'utf8').toString('base64'));
        await waitFor(() => seen(id).includes('before-resize-marker'), 15_000, 'pre-resize output');
        const beforeLen = seen(id).length;

        // Somebody else resizes the window — a local `tmux attach`, another
        // device, anything. v2 deliberately no longer kicks them.
        spawnSync('tmux', ['resize-window', '-t', `=vh-${id}:`, '-x', '64', '-y', '20'], { stdio: 'ignore' });

        await waitFor(() => /\x1b\]6121;64;20\x07/.test(seen(id)), 15_000, 'in-band geometry marker');
        // Ordering matters as much as the value: it must arrive AFTER the bytes
        // that were produced at the old width.
        expect(seen(id).indexOf('\x1b]6121;64;20\x07')).toBeGreaterThanOrEqual(beforeLen - 1);
    });

    it('writing to a terminal whose tmux session just died must not kill the daemon (EPIPE regression)', async () => {
        // 2026-08-17, first hour in production: closing ONE terminal took the
        // whole daemon down. The control client's stdin closes with its tmux
        // session, and the next write (a keystroke, a resize's refresh-client,
        // anything already queued) raised EPIPE as an unhandled stream error →
        // `Starting proper cleanup (source: exception, errorMessage: write
        // EPIPE)` → every terminal on the machine died with it.
        const id = 'v2epipe1';
        const fatal: unknown[] = [];
        const onUncaught = (e: unknown) => fatal.push(e);
        process.on('uncaughtException', onUncaught);
        process.on('unhandledRejection', onUncaught);
        try {
            await mgr.open({ terminalId: id, cols: 80, rows: 24, streamMode: 'lines' });
            await waitFor(() => seen(id).length > 0, 15_000, 'session live');
            // Kill the session out from under the client — the same shape as a
            // user's `exit`, another device's delete, or a machine reboot.
            spawnSync('tmux', ['kill-session', '-t', `=vh-${id}:`], { stdio: 'ignore' });
            // Write into the void, repeatedly, without waiting for the exit
            // event: this IS the race that crashed the daemon.
            for (let i = 0; i < 20; i++) {
                mgr.write(id, Buffer.from('x', 'utf8').toString('base64'));
                mgr.resize(id, 100 + i, 30);
            }
            await new Promise((r) => setTimeout(r, 1500));
            for (let i = 0; i < 10; i++) mgr.write(id, Buffer.from('y', 'utf8').toString('base64'));
            await new Promise((r) => setTimeout(r, 500));
            expect(fatal).toEqual([]);
            // …and the manager is still healthy for OTHER terminals.
            const other = 'v2epipe2';
            const res = await mgr.open({ terminalId: other, cols: 80, rows: 24, streamMode: 'lines' });
            expect(res.streamMode).toBe('lines');
            mgr.killSession(other);
        } finally {
            process.off('uncaughtException', onUncaught);
            process.off('unhandledRejection', onUncaught);
        }
    });

    it('killing a terminal stops its control client (no zombie tmux children)', async () => {
        const id = 'v2kill1';
        await mgr.open({ terminalId: id, cols: 80, rows: 24, streamMode: 'lines' });
        await waitFor(() => seen(id).length > 0, 15_000, 'session live');
        mgr.killSession(id);
        await waitFor(
            () => spawnSync('tmux', ['has-session', '-t', `=vh-${id}:`], { stdio: 'ignore' }).status !== 0,
            10_000,
            'tmux session gone',
        );
        expect(mgr.liveSessionCount?.()).toBeDefined();
    });
});
