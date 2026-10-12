/**
 * B-550 ScrollbackCheckpointer with a FAKE tmux (no subprocesses): promotion,
 * the in-flight-capture race, the switch, GC membership.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScrollbackCheckpointer, type ScrollbackTmux } from './scrollbackCheckpoint';
import { encodeArchiveFile } from './scrollbackArchive';

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function setup(opts: { enabled?: boolean; probe?: string; capture?: (args: string[]) => Promise<Buffer | null> } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'vh-sbcp-'));
    homes.push(home);
    let probe = opts.probe ?? '';
    const tmux: ScrollbackTmux = {
        run: async (args) => (args[0] === 'list-sessions' ? Buffer.from(probe) : (opts.capture ? opts.capture(args) : Buffer.from('captured\n'))),
        runSync: (args) => (args[0] === 'list-sessions' ? Buffer.from(probe) : Buffer.from('sync-captured\n')),
    };
    let enabled = opts.enabled ?? true;
    const cp = new ScrollbackCheckpointer({
        homeDir: () => home,
        env: () => ({}),
        tmux,
        readConfig: () => ({ enabled }),
        now: () => Date.now() + 60_000,
    });
    const dir = join(home, 'terminal-scrollback');
    return {
        cp, dir,
        setProbe: (p: string) => { probe = p; },
        setEnabled: (v: boolean) => { enabled = v; },
        file: (name: string) => join(dir, name),
    };
}

const secs = () => Math.floor(Date.now() / 1000);

describe('ScrollbackCheckpointer', () => {
    it('tick writes .live; promote chains it into .prev; replay reads .prev', async () => {
        const t = setup({ probe: `vh-aa|${secs()}|0|\n` });
        await t.cp.runTick([]);
        expect(readFileSync(t.file('aa.live.vhsb'), 'utf8')).toContain('captured');
        expect(t.cp.replayFor('aa')).toBeNull(); // not rebuilt yet → nothing to replay

        t.cp.promote('aa');
        expect(existsSync(t.file('aa.live.vhsb'))).toBe(false);
        expect(t.cp.replayFor('aa')!.body.toString()).toBe('captured');

        // A second life, then a second rebuild: both lives are in the archive.
        writeFileSync(t.file('aa.live.vhsb'), encodeArchiveFile({ savedAt: Date.now(), body: Buffer.from('second') }));
        t.cp.promote('aa');
        const chained = t.cp.replayFor('aa')!.body.toString();
        expect(chained.indexOf('captured')).toBeLessThan(chained.indexOf('second'));
        expect(chained).toContain('重建');
    });

    it('an in-flight capture that resolves after promote() does not resurrect .live', async () => {
        let release!: (b: Buffer) => void;
        const t = setup({
            probe: `vh-bb|${secs()}|0|\n`,
            capture: () => new Promise<Buffer>((r) => { release = r; }),
        });
        mkdirSync(t.dir, { recursive: true });
        writeFileSync(t.file('bb.live.vhsb'), encodeArchiveFile({ savedAt: 1, body: Buffer.from('old-life') }));
        // Seeded from the existing file's mtime → force due by making it old.
        const tick = t.cp.runTick([]);
        await new Promise((r) => setTimeout(r, 10));
        t.cp.promote('bb'); // rebuild happens while the capture is in flight
        release(Buffer.from('stale-capture\n'));
        await tick;
        expect(existsSync(t.file('bb.live.vhsb'))).toBe(false);
        expect(t.cp.replayFor('bb')!.body.toString()).toBe('old-life');
    });

    it('turning the switch off deletes everything and stops replay/promote', async () => {
        const t = setup({ probe: `vh-cc|${secs()}|0|\n` });
        await t.cp.runTick([]);
        t.cp.promote('cc');
        expect(t.cp.replayFor('cc')).not.toBeNull();
        t.setEnabled(false);
        const off = new ScrollbackCheckpointer({ homeDir: () => join(t.dir, '..'), env: () => ({}), readConfig: () => ({ enabled: false }) });
        expect(off.replayFor('cc')).toBeNull();
        expect(existsSync(t.dir)).toBe(false);
    });

    it('GC keeps live + closed ids and drops the rest; a failed probe deletes by TTL only', async () => {
        const t = setup({ probe: `vh-live1|${secs()}|0|\n` });
        mkdirSync(t.dir, { recursive: true });
        for (const id of ['closed1', 'orphan1']) {
            writeFileSync(t.file(`${id}.prev.vhsb`), encodeArchiveFile({ savedAt: 1, body: Buffer.from(id) }));
        }
        await t.cp.runTick(['closed1']);
        expect(existsSync(t.file('live1.live.vhsb'))).toBe(true);
        expect(existsSync(t.file('closed1.prev.vhsb'))).toBe(true);
        expect(existsSync(t.file('orphan1.prev.vhsb'))).toBe(false);

        writeFileSync(t.file('orphan2.prev.vhsb'), encodeArchiveFile({ savedAt: 1, body: Buffer.from('x') }));
        expect(t.cp.gc(null)).toEqual([]);
        expect(existsSync(t.file('orphan2.prev.vhsb'))).toBe(true);
    });

    it('shutdown flush is a no-op before any tick ran (tests that only construct+stop)', () => {
        const t = setup({ probe: `vh-dd|${secs()}|0|\n` });
        t.cp.flushOnShutdown();
        expect(existsSync(t.dir)).toBe(false);
    });

    it('attach terminals are never checkpointed', async () => {
        const t = setup({ probe: `vh-att|${secs()}|0|my-session\n` });
        await t.cp.runTick([]);
        expect(existsSync(t.file('att.live.vhsb'))).toBe(false);
    });
});
