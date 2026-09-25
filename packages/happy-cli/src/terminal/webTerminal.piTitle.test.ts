/**
 * B-500 on a REAL tmux server (private socket, isolated HAPPY_HOME_DIR): the
 * daemon's list tracker follows pi's NAMED OSC title (`π - <name> - <dir>`,
 * what pi writes after the extension names the session from the first
 * prompt) into `@vh_title` as the bare name, leaves the unnamed `π - <dir>`
 * form as-is, and never touches a tab the user renamed (`@vh_title_manual`).
 * The OSC bytes are the exact sequence pi's terminal writer emits
 * (`\x1b]0;<title>\x07`, verified pi 0.84.4).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createIsolatedTmux, tmuxAvailable } from '@/testing/isolatedTmux';

const happyHome = mkdtempSync(join(tmpdir(), 'vh-pititle-home-'));
const prevHome = process.env.HAPPY_HOME_DIR;
process.env.HAPPY_HOME_DIR = happyHome;
const iso = createIsolatedTmux('vh-pititle');
const { WebTerminalManager } = await import('./webTerminal');

async function until(probe: () => boolean, ms = 10_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (probe()) return true; await new Promise((r) => setTimeout(r, 100)); }
    return false;
}

describe.skipIf(!tmuxAvailable)('pi terminal auto-title follows the named pi OSC title (B-500, real tmux)', () => {
    const mgr = new WebTerminalManager(() => { /* byte stream not under test */ });
    afterAll(() => {
        mgr.stopListTracking();
        iso.dispose();
        if (prevHome === undefined) delete process.env.HAPPY_HOME_DIR; else process.env.HAPPY_HOME_DIR = prevHome;
        rmSync(happyHome, { recursive: true, force: true });
    });

    it('unnamed pi keeps `π - <dir>`, a named pi session becomes the bare name, a manual rename pins the tab', async () => {
        const id = 'pit00000001';
        const target = `=vh-${id}:`;
        const dir = basename(iso.dir);
        await mgr.open({ terminalId: id, cols: 100, rows: 30, cwd: iso.dir });
        const osc = (title: string) => iso.run('send-keys', '-t', target, '-l', '--', `printf '\\033]0;${title}\\007'\r`);
        const item = () => mgr.listSessions().find((t) => t.id === id);
        const stored = () => iso.run('show-options', '-qv', '-t', target, '@vh_title').stdout.trim();

        // 1. pi starts: `π - <dir>` is followed verbatim (today's behaviour, unchanged).
        osc(`π - ${dir}`);
        expect(await until(() => item()?.title === `π - ${dir}`)).toBe(true);
        expect(stored()).toBe(`π - ${dir}`);

        // 2. The extension names the pi session → pi rewrites its title → the tab shows the name only.
        osc(`π - Fix terminal auto-title - ${dir}`);
        expect(await until(() => item()?.title === 'Fix terminal auto-title')).toBe(true);
        expect(stored()).toBe('Fix terminal auto-title');
        expect(item()?.manual).toBeFalsy();

        // 3. /name in pi (or a later generated name after /new) keeps following.
        osc(`π - Second topic - ${dir}`);
        expect(await until(() => item()?.title === 'Second topic')).toBe(true);

        // 4. A sidebar rename pins the tab: pi's next OSC title is ignored.
        expect(mgr.setTitle(id, 'Mine')).toBe(true);
        osc(`π - Generated later - ${dir}`);
        await new Promise((r) => setTimeout(r, 1500));
        expect(item()).toMatchObject({ title: 'Mine', manual: true });
        expect(stored()).toBe('Mine');
        mgr.unsubscribe(id);
    }, 30_000);
});
