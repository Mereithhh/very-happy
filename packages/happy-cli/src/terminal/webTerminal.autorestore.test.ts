/**
 * B-150 auto-restore, against a REAL tmux server (isolated via TMUX_TMPDIR) and
 * an isolated HAPPY_HOME_DIR — both set before importing webTerminal, because
 * `configuration` is a singleton built at import time.
 *
 * What is asserted is the whole point of the feature: after a gap (no tmux
 * server at all = the machine rebooted), the daemon brings the recent working
 * set BACK BY ITSELF — right directory, right conversation, no clicks — while
 * refusing the cases that would make it a resource incident or a wrong resume.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

const happyHome = mkdtempSync(join(tmpdir(), 'vh-ar-home-'));
const tmuxDir = mkdtempSync(join(tmpdir(), 'vh-ar-tmux-'));
const workDir = mkdtempSync(join(tmpdir(), 'vh-ar-work-'));
const prevHome = process.env.HAPPY_HOME_DIR;
const prevTmux = process.env.TMUX_TMPDIR;
process.env.HAPPY_HOME_DIR = happyHome;
process.env.TMUX_TMPDIR = tmuxDir;

const FRESH = 'arfresh01';      // recent + cwd exists + has a conversation → restored
const STALE = 'arstale01';      // last seen 40h ago → a reboot's cleanup must stand
const GONEDIR = 'argone001';    // cwd deleted → never substitute another directory
const SHELL = 'arshell01';      // no conversation → not worth the memory
const UUID_FRESH = 'c0c26854-5e0c-4063-aaeb-d4428fe8ed94';
const UUID_STALE = '11111111-2222-3333-4444-555555555555';
const NOW = Date.now();
const H = 60 * 60 * 1000;

writeFileSync(join(happyHome, 'settings.json'), JSON.stringify({
    schemaVersion: 2,
    onboardingCompleted: true,
    terminalAutoRestore: true,
    terminalAutoRestoreMax: 2,
    terminalAutoRestoreWindowHours: 24,
}));
writeFileSync(join(happyHome, 'live-terminals.json'), JSON.stringify({
    [FRESH]: { title: 'llm-hub postgres', cwd: workDir, seenAt: NOW - 5 * 60 * 1000 },
    [STALE]: { title: 'forgotten', cwd: workDir, seenAt: NOW - 40 * H },
    [GONEDIR]: { title: 'moved away', cwd: join(tmpdir(), 'vh-ar-deleted-nope'), seenAt: NOW - 60_000 },
    [SHELL]: { title: 'bare shell', cwd: workDir, seenAt: NOW - 60_000 },
}));
writeFileSync(join(happyHome, 'sessions.json'), JSON.stringify({
    sessions: {
        mFresh: {
            encryptionKey: 'k', encryptionVariant: 'dataKey', seq: 0,
            metadataVersion: 0, agentStateVersion: 0, savedAt: NOW,
            metadata: { flavor: 'terminal-mirror', terminalId: FRESH, claudeSessionId: UUID_FRESH },
        },
        mStale: {
            encryptionKey: 'k', encryptionVariant: 'dataKey', seq: 0,
            metadataVersion: 0, agentStateVersion: 0, savedAt: NOW,
            metadata: { flavor: 'terminal-mirror', terminalId: STALE, claudeSessionId: UUID_STALE },
        },
        mGone: {
            encryptionKey: 'k', encryptionVariant: 'dataKey', seq: 0,
            metadataVersion: 0, agentStateVersion: 0, savedAt: NOW,
            metadata: { flavor: 'terminal-mirror', terminalId: GONEDIR, claudeSessionId: UUID_STALE },
        },
        // SHELL deliberately has no mirror session → no conversation to resume.
    },
}));

const { WebTerminalManager } = await import('./webTerminal');

function tmux(...args: string[]) {
    return spawnSync('tmux', args, { encoding: 'utf8', env: { ...process.env } });
}
function sessionExists(id: string): boolean {
    return tmux('has-session', '-t', `=vh-${id}:`).status === 0;
}

describe.skipIf(!tmuxAvailable)('terminal auto-restore (B-150, real tmux)', () => {
    const summaries: string[] = [];
    const mgr = new WebTerminalManager(() => { /* stream not under test */ });
    mgr.setOnAutoRestoreSummary((line) => summaries.push(line));

    afterAll(() => {
        mgr.stopListTracking();
        for (const id of [FRESH, STALE, GONEDIR, SHELL]) tmux('kill-session', '-t', `=vh-${id}:`);
        tmux('kill-server');
        for (const d of [happyHome, tmuxDir, workDir]) rmSync(d, { recursive: true, force: true });
        if (prevHome === undefined) delete process.env.HAPPY_HOME_DIR; else process.env.HAPPY_HOME_DIR = prevHome;
        if (prevTmux === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = prevTmux;
    });

    it('restores the recent terminal into its own cwd and types the resume command', async () => {
        mgr.startListTracking(() => { /* pushes not under test */ }, 50);
        // Serial restores are staggered (AUTO_RESTORE_STAGGER_MS) and each spawns
        // tmux; give the chain room without making the test flaky-slow.
        for (let i = 0; i < 60 && !sessionExists(FRESH); i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        expect(sessionExists(FRESH)).toBe(true);

        // Right directory — never a substitute.
        const cwd = tmux('display-message', '-p', '-t', `=vh-${FRESH}:`, '#{pane_current_path}').stdout.trim();
        // realpath both sides: on macOS the temp dir is /var/… (a symlink to
        // /private/var/…) and tmux reports the resolved path.
        expect(realpathSync(cwd)).toBe(realpathSync(workDir));
        // Title carried over so the sidebar row is recognisable immediately.
        const title = tmux('display-message', '-p', '-t', `=vh-${FRESH}:`, '#{@vh_title}').stdout.trim();
        expect(title).toBe('llm-hub postgres');
        // The create-only marker that lets the resumed claude re-bind its mirror
        // (B-105) — without it the NEXT restart would find no conversation.
        const marker = tmux('show-environment', '-t', `=vh-${FRESH}:`, 'VH_TERMINAL_ID').stdout.trim();
        expect(marker).toBe(`VH_TERMINAL_ID=${FRESH}`);
        // The resume command really was typed into the pane.
        const pane = tmux('capture-pane', '-p', '-S', '-', '-t', `=vh-${FRESH}:`).stdout;
        expect(pane).toContain(`claude --resume ${UUID_FRESH}`);
    });

    it('refuses stale sessions, missing directories and bare shells', () => {
        expect(sessionExists(STALE)).toBe(false);    // 40h old — the reboot's cleanup stands
        expect(sessionExists(GONEDIR)).toBe(false);  // cwd gone — no substitute directory
        expect(sessionExists(SHELL)).toBe(false);    // no conversation — not worth the memory
    });

    it('reports what it skipped instead of letting a cap look like success', () => {
        expect(summaries).toHaveLength(1);
        expect(summaries[0]).toContain('Restored 1 terminal');
        expect(summaries[0]).toContain('too old');
        expect(summaries[0]).toContain('directory gone');
        expect(summaries[0]).toContain('no conversation');
    });

    it('marks the restored terminal on the list until it is opened', () => {
        const row = mgr.buildTerminalList().find((t) => t.id === FRESH);
        expect(row?.restoredAt).toBeGreaterThan(0);
    });

    it('does not restore into a shutting-down daemon', async () => {
        // A second manager over the SAME snapshot would normally restore again
        // (its own once-per-life flag is fresh). Tearing it down first must make
        // the restore a no-op: teardown means list pushes and notifications have
        // nowhere to go. Regression for the 2026-08-24 acceptance-run finding.
        const dying = new WebTerminalManager(() => { /* no stream */ });
        const seen: string[] = [];
        dying.setOnAutoRestoreSummary((line) => seen.push(line));
        dying.stopListTracking();                 // flips the shutdown flag
        dying.startListTracking(() => { /* noop */ }, 50);
        await new Promise((r) => setTimeout(r, 300));
        expect(seen).toEqual([]);
    });

    it('is idempotent: a second reconcile never double-creates', async () => {
        // The reconcile is once-per-daemon-life; drive more ticks and assert the
        // session count for our ids stays at exactly one.
        await new Promise((r) => setTimeout(r, 200));
        const names = tmux('list-sessions', '-F', '#{session_name}').stdout.split('\n').filter(Boolean);
        expect(names.filter((n) => n === `vh-${FRESH}`)).toHaveLength(1);
    });
});
