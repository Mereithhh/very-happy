/**
 * End-to-end test of the daemon-side terminal-list PUSH chain against a REAL
 * tmux server (isolated via TMUX_TMPDIR — never touches the user's sessions):
 *
 *   open() → kick → list push        (membership)
 *   OSC title from inside the pane → tmux pane_title → set-titles re-emit →
 *     headless onTitleChange → kick → @vh_title follow → list push (title)
 *   setTitle()/setTags() → immediate pushes
 *   killSession() → push WITHOUT the terminal (deletion-by-absence)
 *
 * The tracking interval is set absurdly long, so every observed push must have
 * been produced by an EVENT KICK — if any event source breaks, its step times
 * out instead of being silently rescued by the periodic tick.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WebTerminalManager, type TerminalListItem } from './webTerminal';

const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

/** Poll until `probe` returns a truthy value or the timeout hits. */
async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 15_000, label = 'condition'): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = probe();
        if (v) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 100));
    }
}

describe.skipIf(!tmuxAvailable)('terminal list tracking pushes (real tmux, isolated server)', () => {
    let dir: string;
    let savedTmpdir: string | undefined;
    let mgr: WebTerminalManager;
    const pushes: TerminalListItem[][] = [];
    /** Every ephemeral `terminal-activity` frame, with arrival time. */
    const activity: Array<{ at: number; terminals: Array<{ id: string; activityAt: number }> }> = [];
    const TID = 'trkpush1';

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'vh-tracker-'));
        savedTmpdir = process.env.TMUX_TMPDIR;
        // Isolated tmux server: every tmux invocation in the manager builds its
        // env from process.env (ptyEnv), so this redirects the server socket.
        process.env.TMUX_TMPDIR = dir;
        mgr = new WebTerminalManager((event, payload) => {
            // Byte stream not under test; the ephemeral activity lane IS.
            if (event === 'terminal-activity') activity.push({ at: Date.now(), terminals: payload.terminals });
        });
        // Interval so long it can't fire within the test — kicks must carry it.
        mgr.startListTracking((list) => pushes.push(list), 10 * 60 * 1000);
    });

    afterAll(() => {
        mgr?.stopListTracking();
        try { mgr?.killSession(TID); } catch { /* already gone */ }
        spawnSync('tmux', ['kill-server'], { stdio: 'ignore', env: { ...process.env, TMUX_TMPDIR: dir } as any });
        if (savedTmpdir === undefined) delete process.env.TMUX_TMPDIR;
        else process.env.TMUX_TMPDIR = savedTmpdir;
        rmSync(dir, { recursive: true, force: true });
    });

    it('pushes on open, live OSC title change, manual rename, and kill', async () => {
        // ── open: membership push ────────────────────────────────────────────
        const result = await mgr.open({ terminalId: TID, cols: 80, rows: 24, cwd: dir });
        expect(result.terminalId).toBe(TID);
        expect(result.tmuxSession).toBe(`vh-${TID}`);
        await waitFor(
            () => pushes.some((l) => l.some((t) => t.id === TID)),
            15_000, 'open() membership push',
        );

        // ── live OSC title → onTitleChange kick → @vh_title follow → push ────
        // Type an OSC 2 title-set into the pane's shell. The push chain must
        // deliver the derived title (glyphless, meaningful) to the list.
        const cmd = `printf '\\033]2;integration task title\\007'\r`;
        mgr.write(TID, Buffer.from(cmd, 'utf8').toString('base64'));
        await waitFor(
            () => pushes.some((l) => l.some((t) => t.id === TID && t.title === 'integration task title')),
            15_000, 'OSC title push',
        );

        // ── manual rename: immediate push + pins the title ──────────────────
        const before = pushes.length;
        expect(mgr.setTitle(TID, 'pinned name', false)).toBe(true);
        await waitFor(
            () => pushes.slice(before).some((l) => l.some((t) => t.id === TID && t.title === 'pinned name')),
            15_000, 'rename push',
        );
        // A later OSC title must NOT displace the manual rename (@vh_title_manual).
        mgr.write(TID, Buffer.from(`printf '\\033]2;should not win\\007'\r`, 'utf8').toString('base64'));
        await new Promise((r) => setTimeout(r, 1500));
        const current = mgr.buildTerminalList().find((t) => t.id === TID);
        expect(current?.title).toBe('pinned name');

        // ── tags: tmux persistence + immediate capability-bearing push ─────
        const beforeTags = pushes.length;
        expect(mgr.setTags(TID, ['prod', 'deploy'])).toBe(true);
        await waitFor(
            () => pushes.slice(beforeTags).some((l) => l.some((t) => t.id === TID && JSON.stringify(t.tags) === '["prod","deploy"]')),
            15_000, 'tag push',
        );
        expect(mgr.setTags(TID, [])).toBe(true);
        expect(mgr.buildTerminalList().find((t) => t.id === TID)?.tags).toEqual([]);

        // ── kill: deletion propagates by absence ─────────────────────────────
        const beforeKill = pushes.length;
        mgr.killSession(TID);
        await waitFor(
            () => pushes.slice(beforeKill).some((l) => l.every((t) => t.id !== TID)),
            15_000, 'kill push',
        );

        // Every push was event-driven (interval could not have fired), and the
        // signature gate means none of them were identical repeats.
        expect(pushes.length).toBeGreaterThanOrEqual(3);
    }, 60_000);

    it('pure OUTPUT produces a realtime activity frame in ~a second, then goes quiet', async () => {
        // This is the whole point of the ephemeral lane: output ALONE (no
        // title/agent/membership change) must float the row now, not up to a
        // minute later when the daemonState activity bucket happens to flip.
        // The tracking interval here is 10 MINUTES, so nothing in this test can
        // be rescued by a periodic tick — every frame is output-driven.
        const TID5 = 'trkact1';
        await mgr.open({ terminalId: TID5, cols: 80, rows: 24, cwd: dir });
        try {
            const start = activity.length;
            const t0 = Date.now();
            // Make the pane print something without touching its title.
            mgr.write(TID5, Buffer.from(`printf 'hello-activity\\n'\r`, 'utf8').toString('base64'));
            const frame = await waitFor(
                () => activity.slice(start).find((f) => f.terminals.some((t) => t.id === TID5)),
                10_000, 'realtime activity frame for pure output',
            );
            // Well inside the 60s bucket the persisted lane is stuck behind.
            // Measured 0ms on a warm tmux — the leading-edge throttle fires on
            // the very first chunk. The bound is generous for CI noise.
            expect(frame.at - t0).toBeLessThan(3_000);
            const item = frame.terminals.find((t) => t.id === TID5)!;
            expect(item.activityAt).toBeGreaterThan(t0 - 1_000);

            // Throttle: a continuous burst must not become a per-chunk firehose.
            const burstStart = activity.length;
            for (let i = 0; i < 20; i++) {
                mgr.write(TID5, Buffer.from(`printf 'x%d\\n' ${i}\r`, 'utf8').toString('base64'));
            }
            await new Promise((r) => setTimeout(r, 2_000));
            const burstFrames = activity.length - burstStart;
            expect(burstFrames).toBeGreaterThan(0);
            expect(burstFrames).toBeLessThanOrEqual(4); // ~1/s + leading edge

            // Idle: nothing moved ⇒ nothing sent. An idle machine is free.
            const idleStart = activity.length;
            await new Promise((r) => setTimeout(r, 2_500));
            expect(activity.length).toBe(idleStart);
        } finally {
            mgr.killSession(TID5);
        }
    }, 60_000);

    it('open() applies the native-feel session options (status bar off)', async () => {
        const TID4 = 'trkopts1';
        await mgr.open({ terminalId: TID4, cols: 80, rows: 24, cwd: dir });
        try {
            // Session-scoped `status off` is part of the per-open option batch
            // (native-terminal feel: the web header owns the title, the green
            // bar is tmux noise). `show-options -t` prints the session value.
            const r = spawnSync('tmux', ['show-options', '-t', `=vh-${TID4}:`, 'status'], { encoding: 'utf8' });
            expect(r.status).toBe(0);
            expect(r.stdout.trim()).toBe('status off');
            // And the pane got the full client height back (no bar row eaten).
            const h = spawnSync('tmux', ['display-message', '-p', '-t', `=vh-${TID4}:`, '#{pane_height}'], { encoding: 'utf8' });
            expect(h.stdout.trim()).toBe('24');
        } finally {
            mgr.killSession(TID4);
        }
    }, 30_000);

    it('attach-only opens never resurrect a killed terminal (the delete-resurrection bug)', async () => {
        const TID2 = 'trkgone1';
        await mgr.open({ terminalId: TID2, cols: 80, rows: 24, cwd: dir });
        await waitFor(
            () => pushes.some((l) => l.some((t) => t.id === TID2)),
            15_000, `open() membership push for ${TID2}`,
        );
        mgr.killSession(TID2);
        await waitFor(
            () => pushes[pushes.length - 1]?.every((t) => t.id !== TID2),
            15_000, 'kill push (absence)',
        );

        // A lingering screen's catch-up (`resub`) and any attach-only open must
        // FAIL — with create-or-attach they used to recreate `vh-<id>` and the
        // push re-adopted the "deleted" terminal everywhere.
        await expect(mgr.open({ terminalId: TID2, cols: 80, rows: 24, cwd: dir, resub: true }))
            .rejects.toThrow('terminal-gone');
        await expect(mgr.open({ terminalId: TID2, cols: 80, rows: 24, cwd: dir, attachOnly: true }))
            .rejects.toThrow('terminal-gone');
        expect(spawnSync('tmux', ['has-session', '-t', `=vh-${TID2}:`], { stdio: 'ignore' }).status).not.toBe(0);

        // Attach-only DOES attach when the tmux session exists without a live
        // pty (daemon restart / idle-reaped pty): create one out-of-band.
        const TID3 = 'trkext1';
        expect(spawnSync('tmux', ['new-session', '-d', '-s', `vh-${TID3}`], { stdio: 'ignore' }).status).toBe(0);
        const attached = await mgr.open({ terminalId: TID3, cols: 80, rows: 24, cwd: dir, attachOnly: true });
        expect(attached.terminalId).toBe(TID3);
        expect(attached.tmuxSession).toBe(`vh-${TID3}`);
        mgr.killSession(TID3);

        // Kill tombstones: even a legacy create-or-attach open (no flags) must
        // NOT resurrect a killed id — this WAS the delete-resurrection bug
        // (stale-client legacy opens recreating deleted terminals).
        await expect(mgr.open({ terminalId: TID2, cols: 80, rows: 24, cwd: dir }))
            .rejects.toThrow('terminal-gone');
    }, 60_000);
});
