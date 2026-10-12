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

function setup(opts: { enabled?: boolean; probe?: string; capture?: (args: string[]) => Promise<Buffer | null>; runSync?: (args: string[]) => Buffer | null } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'vh-sbcp-'));
    homes.push(home);
    let probe = opts.probe ?? '';
    const tmux: ScrollbackTmux = {
        run: async (args) => (args[0] === 'list-sessions' ? Buffer.from(probe) : (opts.capture ? opts.capture(args) : Buffer.from('captured\n'))),
        runSync: (args) => (opts.runSync ? opts.runSync(args) : args[0] === 'list-sessions' ? Buffer.from(probe) : Buffer.from('sync-captured\n')),
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

    it('shutdown flush is a no-op before any tick ran (tests that only construct+stop)', async () => {
        const t = setup({ probe: `vh-dd|${secs()}|0|\n` });
        await t.cp.flushOnShutdown();
        expect(existsSync(t.dir)).toBe(false);
    });

    it('shutdown flush: parallel, newest activity first, resolves by the budget even if a capture hangs', async () => {
        const order: string[] = [];
        const t = setup({
            probe: '',
            capture: (args) => {
                const target = args[args.indexOf('-t') + 1];
                order.push(target);
                // `hang` never answers; `fast` answers at once.
                return target === '=vh-hang:' ? new Promise<Buffer | null>(() => { /* never */ }) : Promise.resolve(Buffer.from(`${target}\n`));
            },
        });
        await t.cp.runTick([]); // started; nothing listed yet
        const s0 = secs();
        t.setProbe(`vh-old|${s0 - 100}|0|\nvh-hang|${s0 - 50}|0|\nvh-fast|${s0}|0|\n`);
        const started = Date.now();
        await t.cp.flushOnShutdown(200);
        expect(Date.now() - started).toBeLessThan(600);
        expect(order).toEqual(['=vh-fast:', '=vh-hang:', '=vh-old:']); // all issued at once, newest first
        expect(readFileSync(t.file('fast.live.vhsb'), 'utf8')).toContain('=vh-fast:');
        expect(existsSync(t.file('hang.live.vhsb'))).toBe(false);
    });

    it('promote keeps .live when the chained .prev cannot be written', async () => {
        const t = setup({ probe: `vh-ee|${secs()}|0|\n` });
        await t.cp.runTick([]);
        // A non-empty DIRECTORY where .prev should go → the atomic rename fails.
        mkdirSync(join(t.file('ee.prev.vhsb'), 'blocker'), { recursive: true });
        t.cp.promote('ee');
        expect(readFileSync(t.file('ee.live.vhsb'), 'utf8')).toContain('captured');
    });

    it('promote() undo restores both files exactly (rebuild did not happen)', async () => {
        const t = setup({ probe: `vh-ff|${secs()}|0|\n` });
        mkdirSync(t.dir, { recursive: true });
        const prevBytes = encodeArchiveFile({ savedAt: 1, body: Buffer.from('older') });
        writeFileSync(t.file('ff.prev.vhsb'), prevBytes);
        await t.cp.runTick([]);
        const liveBytes = readFileSync(t.file('ff.live.vhsb'));
        const undo = t.cp.promote('ff');
        expect(existsSync(t.file('ff.live.vhsb'))).toBe(false);
        expect(t.cp.replayFor('ff')!.body.toString()).toContain('captured');
        undo();
        expect(readFileSync(t.file('ff.live.vhsb')).equals(liveBytes)).toBe(true);
        expect(readFileSync(t.file('ff.prev.vhsb')).equals(prevBytes)).toBe(true);

        // No prior .prev: undo removes the one promote created.
        const t2 = setup({ probe: `vh-gg|${secs()}|0|\n` });
        await t2.cp.runTick([]);
        t2.cp.promote('gg')();
        expect(existsSync(t2.file('gg.prev.vhsb'))).toBe(false);
        expect(existsSync(t2.file('gg.live.vhsb'))).toBe(true);
    });

    it('checkpointSync captures one terminal (alt aware), skips attach terminals', () => {
        const calls: string[][] = [];
        const t = setup({
            runSync: (args) => {
                calls.push(args);
                if (args[0] === 'display-message') return Buffer.from(args[3] === '=vh-att2:' ? '0|work\n' : '1|\n');
                return Buffer.from(`part-${calls.length}\n`);
            },
        });
        expect(t.cp.checkpointSync('kk')).toBe(true);
        const text = readFileSync(t.file('kk.live.vhsb'), 'utf8');
        expect(text).toContain('part-2');
        expect(text).toContain('part-3'); // alt: history + saved screen
        expect(t.cp.checkpointSync('att2')).toBe(false);
        expect(existsSync(t.file('att2.live.vhsb'))).toBe(false);
        expect(t.cp.checkpointSync('../x')).toBe(false);
    });

    it('attach terminals are never checkpointed', async () => {
        const t = setup({ probe: `vh-att|${secs()}|0|my-session\n` });
        await t.cp.runTick([]);
        expect(existsSync(t.file('att.live.vhsb'))).toBe(false);
    });
});
