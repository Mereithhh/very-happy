/**
 * B-550 scrollback persistence end to end against a REAL tmux server (private
 * socket, src/testing/isolatedTmux.ts) and an isolated HAPPY_HOME_DIR — both
 * set before importing webTerminal (configuration is an import-time singleton).
 *
 * Asserted: a checkpoint lands on disk (0600 in a 0700 dir); rebuilding the
 * terminal (↻ restore) promotes it; the rebuilt terminal's lines-mode `full`
 * history carries the old output between the separators while the NEW pane
 * never received it as input; the shutdown flush captures dirty terminals;
 * `terminalScrollbackPersist: false` disables replay and deletes the files.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedTmux, tmuxAvailable } from '@/testing/isolatedTmux';

const happyHome = mkdtempSync(join(tmpdir(), 'vh-sb-home-'));
const iso = createIsolatedTmux('vh-sb-tmux');
const workDir = mkdtempSync(join(tmpdir(), 'vh-sb-work-'));
const prevHome = process.env.HAPPY_HOME_DIR;
process.env.HAPPY_HOME_DIR = happyHome;

const SB = 'sbterm001';
const FLUSH = 'sbflush01';
const NOW = Date.now();
writeFileSync(join(happyHome, 'closed-terminals.json'), JSON.stringify([
    { id: SB, title: 'build logs', cwd: workDir, reason: 'closed', closedAt: NOW - 1000 },
]));

const { WebTerminalManager } = await import('./webTerminal');
const { ScrollbackCheckpointer } = await import('./scrollbackCheckpoint');
const tmux = (...args: string[]) => iso.run(...args);
const dir = join(happyHome, 'terminal-scrollback');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A checkpointer on the same directory whose clock runs ahead, so the 3s
 *  quiet window is already over without sleeping. */
const ahead = () => new ScrollbackCheckpointer({
    homeDir: () => happyHome,
    env: () => iso.env,
    now: () => Date.now() + 60_000,
});

async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
    const until = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > until) throw new Error('timed out');
        await sleep(50);
    }
}

describe.skipIf(!tmuxAvailable)('terminal scrollback persistence (B-550, real tmux)', () => {
    const mgr = new WebTerminalManager(() => { /* stream not under test */ });

    afterAll(() => {
        mgr.stopListTracking();
        for (const id of [SB, FLUSH]) tmux('kill-session', '-t', `=vh-${id}:`);
        iso.dispose();
        for (const d of [happyHome, workDir]) rmSync(d, { recursive: true, force: true });
        if (prevHome === undefined) delete process.env.HAPPY_HOME_DIR; else process.env.HAPPY_HOME_DIR = prevHome;
    });

    it('checkpoints a terminal to a private file', async () => {
        expect(tmux('new-session', '-d', '-s', `vh-${SB}`, '-x', '80', '-y', '24', '-c', workDir, '/bin/sh').status).toBe(0);
        // The command line holds `OLD-%s` and `MARKER` apart; only the OUTPUT
        // contains `OLD-MARKER` — what must never reach the new pane's input.
        tmux('send-keys', '-t', `=vh-${SB}:`, '-l', "printf '\\033[42mOLD-%s\\033[0m\\n' MARKER");
        tmux('send-keys', '-t', `=vh-${SB}:`, 'Enter');
        await waitFor(() => tmux('capture-pane', '-p', '-t', `=vh-${SB}:`).stdout.includes('OLD-MARKER'));

        await ahead().runTick([SB]);
        const live = join(dir, `${SB}.live.vhsb`);
        expect(existsSync(live)).toBe(true);
        expect(statSync(live).mode & 0o777).toBe(0o600);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        const text = readFileSync(live, 'utf8');
        expect(text.startsWith('VHSB1 ')).toBe(true);
        expect(text).toContain('OLD-MARKER');
        expect(text).toContain('\x1b[42m');
    });

    it('a rebuilt terminal replays the old output above its own, as history only', async () => {
        tmux('kill-session', '-t', `=vh-${SB}:`);
        expect(mgr.restoreClosedTerminal(SB)).toEqual({ type: 'success', terminalId: SB });
        // Promoted: the life that ended is now the archive.
        expect(existsSync(join(dir, `${SB}.live.vhsb`))).toBe(false);
        expect(readFileSync(join(dir, `${SB}.prev.vhsb`), 'utf8')).toContain('OLD-MARKER');

        const res = await mgr.open({ terminalId: SB, streamMode: 'lines', attachOnly: true, cols: 80, rows: 24 });
        expect(res.mode).toBe('snapshot');
        if (res.mode !== 'snapshot') return;
        // The instant inline snapshot is untouched …
        expect(Buffer.from(res.data, 'base64').toString('utf8')).not.toContain('以下为上次会话的输出');
        // … the deep history carries archive + separators, in order.
        const pages: Buffer[] = [];
        for (let p = 0; p < (res.totalPages ?? 0); p++) {
            const page = mgr.getHistoryPage(SB, res.snapshotId!, p);
            if ('expired' in page) throw new Error('expired');
            pages.push(Buffer.from(page.data, 'base64'));
        }
        const full = Buffer.concat(pages).toString('utf8');
        const head = full.indexOf('以下为上次会话的输出');
        const old = full.indexOf('OLD-MARKER');
        const foot = full.indexOf('以上为上次会话的输出');
        expect(head).toBeGreaterThanOrEqual(0);
        expect(head).toBeLessThan(old);
        expect(old).toBeLessThan(foot);

        // Never fed to the new shell: the rebuilt pane itself has no trace of it.
        await sleep(300);
        expect(tmux('capture-pane', '-p', '-S', '-', '-t', `=vh-${SB}:`).stdout).not.toContain('OLD-MARKER');
        mgr.unsubscribe(SB);
    });

    it('the shutdown flush captures a dirty terminal without waiting for quiet', async () => {
        expect(tmux('new-session', '-d', '-s', `vh-${FLUSH}`, '-x', '80', '-y', '24', '-c', workDir, '/bin/sh').status).toBe(0);
        const cp = new ScrollbackCheckpointer({ homeDir: () => happyHome, env: () => iso.env });
        await cp.runTick([]); // started; FLUSH has never been checkpointed but is not quiet yet
        tmux('send-keys', '-t', `=vh-${FLUSH}:`, '-l', "printf 'FLUSH-%s\\n' NOW");
        tmux('send-keys', '-t', `=vh-${FLUSH}:`, 'Enter');
        await waitFor(() => tmux('capture-pane', '-p', '-t', `=vh-${FLUSH}:`).stdout.includes('FLUSH-NOW'));
        cp.flushOnShutdown();
        expect(readFileSync(join(dir, `${FLUSH}.live.vhsb`), 'utf8')).toContain('FLUSH-NOW');
    });

    it('terminalScrollbackPersist=false: no replay, files deleted', () => {
        writeFileSync(join(happyHome, 'settings.json'), JSON.stringify({ terminalScrollbackPersist: false }));
        const cp = new ScrollbackCheckpointer({ homeDir: () => happyHome, env: () => iso.env });
        expect(cp.replayFor(SB)).toBeNull();
        expect(existsSync(dir)).toBe(false);
    });
});
