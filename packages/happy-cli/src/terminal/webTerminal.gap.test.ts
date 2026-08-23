/**
 * B-149 regression: a daemon that comes back to a machine where the tmux server
 * is GONE must archive what the previous life left behind.
 *
 * This is the exact 2026-08-23 production failure: mac-office rebooted, 22 live
 * terminals disappeared, and because closure detection only diffed an in-memory
 * cache, nothing was recorded anywhere — the terminals had to be reconstructed
 * by hand from daemon logs. The reboot is reproduced without rebooting anything:
 * TMUX_TMPDIR points at an empty directory, so `tmux list-sessions` finds no
 * server and the live list is legitimately empty.
 *
 * Both env overrides must be set BEFORE importing webTerminal — `configuration`
 * is a singleton built at import time, and pointing HAPPY_HOME_DIR at a temp dir
 * is what keeps the suite from writing into the developer's real ~/.happy.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const happyHome = mkdtempSync(join(tmpdir(), 'vh-gap-home-'));
const tmuxDir = mkdtempSync(join(tmpdir(), 'vh-gap-tmux-'));
// Saved so afterAll can put them back: unit files share a worker process, and
// leaking HAPPY_HOME_DIR would point OTHER suites at this (deleted) temp dir.
const prevHome = process.env.HAPPY_HOME_DIR;
const prevTmux = process.env.TMUX_TMPDIR;
process.env.HAPPY_HOME_DIR = happyHome;
process.env.TMUX_TMPDIR = tmuxDir;

const GONE = 'gapgone1';
const CLAUDE_ID = 'c0c26854-5e0c-4063-aaeb-d4428fe8ed94';
const SEEN_AT = Date.now() - 60_000;

// B-150 auto-restore is ON by default and would legitimately bring this
// terminal BACK (recent, cwd exists, conversation known) — which is a different
// test (webTerminal.autorestore.test.ts). Here we assert the ARCHIVE behaviour,
// so the machine-local switch is explicitly off.
writeFileSync(join(happyHome, 'settings.json'), JSON.stringify({
    schemaVersion: 2, onboardingCompleted: true, terminalAutoRestore: false,
}));

// The snapshot the previous daemon life left on disk…
writeFileSync(join(happyHome, 'live-terminals.json'), JSON.stringify({
    [GONE]: { title: 'llm-hub postgres 健康检查', cwd: '/tmp', seenAt: SEEN_AT },
}));
// …and the persisted mirror session that knows which claude ran inside it.
writeFileSync(join(happyHome, 'sessions.json'), JSON.stringify({
    sessions: {
        mirror1: {
            encryptionKey: 'k', encryptionVariant: 'dataKey', seq: 0,
            metadataVersion: 0, agentStateVersion: 0, savedAt: Date.now(),
            metadata: { flavor: 'terminal-mirror', terminalId: GONE, claudeSessionId: CLAUDE_ID },
        },
    },
}));

const { WebTerminalManager } = await import('./webTerminal');

describe('daemon-gap reconcile (B-149)', () => {
    const mgr = new WebTerminalManager(() => { /* no stream under test */ });

    afterAll(() => {
        mgr.stopListTracking();
        rmSync(happyHome, { recursive: true, force: true });
        rmSync(tmuxDir, { recursive: true, force: true });
        if (prevHome === undefined) delete process.env.HAPPY_HOME_DIR; else process.env.HAPPY_HOME_DIR = prevHome;
        if (prevTmux === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = prevTmux;
    });

    it('archives the vanished terminal with its cwd, mirror and resume id', async () => {
        expect(mgr.getClosedTerminals()).toHaveLength(0);

        mgr.startListTracking(() => { /* pushes not under test */ }, 50);
        await new Promise((r) => setTimeout(r, 400));

        const records = mgr.getClosedTerminals();
        expect(records).toHaveLength(1);
        const [rec] = records;
        expect(rec.id).toBe(GONE);
        expect(rec.reason).toBe('daemon-gap');
        expect(rec.title).toBe('llm-hub postgres 健康检查');
        expect(rec.cwd).toBe('/tmp');
        expect(rec.mirrorSessionId).toBe('mirror1');
        expect(rec.claudeSessionId).toBe(CLAUDE_ID);
        // The record dates from when the terminal was last seen ALIVE, not from
        // whenever the daemon happened to boot again.
        expect(rec.closedAt).toBe(SEEN_AT);

        // Persisted, so the archive survives this daemon too.
        const onDisk = JSON.parse(readFileSync(join(happyHome, 'closed-terminals.json'), 'utf8'));
        expect(onDisk[0].id).toBe(GONE);

        // Reconcile is once-only: a later tick must not re-add or duplicate it.
        await new Promise((r) => setTimeout(r, 200));
        expect(mgr.getClosedTerminals()).toHaveLength(1);
    });

    it('leaves no snapshot file behind claiming dead terminals are live', () => {
        // Nothing is alive, so the mirrored cache must be empty (or absent) —
        // otherwise the next start would tombstone the same ids all over again.
        const p = join(happyHome, 'live-terminals.json');
        const snapshot = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
        expect(Object.keys(snapshot)).toHaveLength(0);
    });
});
