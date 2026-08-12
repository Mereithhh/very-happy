/**
 * End-to-end test of the daemon-side terminal-list PUSH chain against a REAL
 * tmux server (isolated via TMUX_TMPDIR — never touches the user's sessions):
 *
 *   open() → kick → list push        (membership)
 *   OSC title from inside the pane → tmux pane_title → set-titles re-emit →
 *     headless onTitleChange → kick → @vh_title follow → list push (title)
 *   setTitle() (manual rename) → immediate push + auto-follow pinned off
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
    const TID = 'trkpush1';

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'vh-tracker-'));
        savedTmpdir = process.env.TMUX_TMPDIR;
        // Isolated tmux server: every tmux invocation in the manager builds its
        // env from process.env (ptyEnv), so this redirects the server socket.
        process.env.TMUX_TMPDIR = dir;
        mgr = new WebTerminalManager(() => { /* byte stream not under test */ });
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
        const result = mgr.open({ terminalId: TID, cols: 80, rows: 24, cwd: dir });
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
});
