/**
 * B-550 pure rules: sanitising, checkpoint bodies, file format, chaining,
 * replay assembly (rendered into a headless xterm and asserted by CELL, B-288
 * style), tick planning and GC.
 */
import { describe, it, expect } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { assembleRestore, type PaneState } from './captureAssembly';
import {
    ARCHIVE_FOOTER_LINE,
    CHECKPOINT_MAX_DIRTY_MS,
    CHECKPOINT_MIN_INTERVAL_MS,
    CHECKPOINT_QUIET_MS,
    SCROLLBACK_FILE_MAX_BYTES,
    SCROLLBACK_PERSIST_DEFAULT,
    SCROLLBACK_TTL_MS,
    archiveFileName,
    buildCheckpointBody,
    chainArchive,
    checkpointCaptureArgs,
    decodeArchiveFile,
    encodeArchiveFile,
    parseArchiveFileName,
    parseCheckpointProbe,
    planCheckpoints,
    planScrollbackGc,
    resolveScrollbackConfig,
    sanitizeArchivedScrollback,
    withArchivedScrollback,
    type ArchiveFileEntry,
} from './scrollbackArchive';

const b = (s: string) => Buffer.from(s, 'utf8');
const s = (buf: Buffer) => buf.toString('utf8');

describe('sanitizeArchivedScrollback', () => {
    it('keeps text, UTF-8, TAB/CR/LF and SGR', () => {
        const input = 'a\tb\r\n中文 \x1b[1;38;2;1:2:3m bold \x1b[0m\n';
        expect(s(sanitizeArchivedScrollback(b(input)))).toBe(input);
    });

    it('drops cursor movement, mode switches, clears and other CSI whole', () => {
        const out = s(sanitizeArchivedScrollback(b('A\x1b[2;5HB\x1b[?1049hC\x1b[2JD\x1b[KE\x1b[>0cF')));
        expect(out).toBe('ABCDEF');
    });

    it('drops OSC 52 (clipboard write), OSC 8 links and DCS/APC strings', () => {
        const out = s(sanitizeArchivedScrollback(b(
            'x\x1b]52;c;cHduZWQ=\x07y\x1b]8;;https://e.vil\x1b\\link\x1b]8;;\x1b\\z\x1bPq#0\x1b\\w\x1b_apc\x1b\\v',
        )));
        expect(out).toBe('xylinkzwv');
    });

    it('drops C0 (BEL, BS, …), DEL and UTF-8 encoded C1, keeps other non-ASCII', () => {
        const out = sanitizeArchivedScrollback(Buffer.concat([
            b('a\x07b\x08c\x7fd'), Buffer.from([0xc2, 0x9b]), b('e'), Buffer.from([0xc2, 0xa9]), b('é'),
        ]));
        expect(s(out)).toBe('abcde©é');
    });

    it('a torn sequence swallows only itself, not the following lines', () => {
        expect(s(sanitizeArchivedScrollback(b('keep\x1b[12;\nnext line\x1b]0;title\nlast\x1b')))).toBe('keep\nnext line\nlast');
    });

    it('SGR with intermediates or private params is not SGR', () => {
        expect(s(sanitizeArchivedScrollback(b('a\x1b[?1mb\x1b[1 mc')))).toBe('abc');
    });
});

describe('buildCheckpointBody', () => {
    it('CRLF seams, trailing blank rows dropped, reset between parts', () => {
        const body = buildCheckpointBody([b('h1\nh2\n\n\n'), b('saved\n   \n\x1b[0m\n')]);
        expect(s(body)).toBe('h1\r\nh2\x1b[0m\r\nsaved');
    });

    it('sanitises before storing', () => {
        expect(s(buildCheckpointBody([b('a\x1b]52;c;Zm9v\x07b\x1b[31mred\n')]))).toBe('ab\x1b[31mred');
    });

    it('keeps the NEWEST bytes, cut on a line boundary', () => {
        const lines = Array.from({ length: 2000 }, (_, i) => `line-${String(i).padStart(5, '0')}-${'x'.repeat(40)}`);
        const body = buildCheckpointBody([b(lines.join('\n') + '\n')], 10_000);
        expect(body.length).toBeLessThanOrEqual(10_000);
        const text = s(body);
        expect(text.endsWith(lines[1999])).toBe(true);
        expect(text.startsWith('line-')).toBe(true);
    });

    it('empty / blank-only input → empty body', () => {
        expect(buildCheckpointBody([b('\n\n  \n')]).length).toBe(0);
    });
});

describe('archive file format', () => {
    it('round-trips', () => {
        const file = { savedAt: 1_790_000_000_000, body: b('hello\r\n\x1b[32mgreen\x1b[0m') };
        expect(decodeArchiveFile(encodeArchiveFile(file))).toEqual(file);
    });

    it('rejects malformed headers and empty bodies', () => {
        expect(decodeArchiveFile(null)).toBeNull();
        expect(decodeArchiveFile(b(''))).toBeNull();
        expect(decodeArchiveFile(b('VHSB2 123\nbody'))).toBeNull();
        expect(decodeArchiveFile(b('VHSB1 abc\nbody'))).toBeNull();
        expect(decodeArchiveFile(b('no header at all'))).toBeNull();
        expect(decodeArchiveFile(b('VHSB1 123\n'))).toBeNull();
    });

    it('re-sanitises and re-caps a tampered body', () => {
        const big = 'z'.repeat(100) + '\n';
        const raw = b(`VHSB1 5\n\x1b]52;c;evil\x07${big.repeat(Math.ceil((SCROLLBACK_FILE_MAX_BYTES * 2) / big.length))}`);
        const decoded = decodeArchiveFile(raw)!;
        expect(decoded.body.length).toBeLessThanOrEqual(SCROLLBACK_FILE_MAX_BYTES);
        expect(s(decoded.body)).not.toContain(']52');
    });

    it('file names are validated (no path traversal)', () => {
        expect(archiveFileName('abc_12-x', 'live')).toBe('abc_12-x.live.vhsb');
        expect(() => archiveFileName('../etc', 'prev')).toThrow();
        expect(parseArchiveFileName('abc.prev.vhsb')).toEqual({ id: 'abc', kind: 'prev' });
        expect(parseArchiveFileName('abc.prev.vhsb.123.tmp')).toBeNull();
        expect(parseArchiveFileName('../x.live.vhsb')).toBeNull();
    });
});

describe('chainArchive', () => {
    const prev = { savedAt: 100, body: b('old') };
    const live = { savedAt: 200, body: b('new') };
    it('either side alone passes through', () => {
        expect(chainArchive(null, null)).toBeNull();
        expect(chainArchive(prev, null)).toEqual(prev);
        expect(chainArchive(null, live)).toEqual(live);
    });
    it('prev ⊕ separator ⊕ live, newest savedAt', () => {
        const c = chainArchive(prev, live)!;
        expect(c.savedAt).toBe(200);
        const t = s(c.body);
        expect(t.startsWith('old\x1b[0m\r\n')).toBe(true);
        expect(t).toContain('重建');
        expect(t.endsWith('\r\nnew')).toBe(true);
    });
    it('caps to the newest bytes', () => {
        const big = { savedAt: 1, body: b(('p'.repeat(99) + '\r\n').repeat(100)) };
        const c = chainArchive(big, live, 1000)!;
        expect(c.body.length).toBeLessThanOrEqual(1000);
        expect(s(c.body).endsWith('new')).toBe(true);
    });
});

describe('resolveScrollbackConfig', () => {
    it('absent / malformed → default; boolean honoured', () => {
        expect(resolveScrollbackConfig(undefined).enabled).toBe(SCROLLBACK_PERSIST_DEFAULT);
        expect(resolveScrollbackConfig({ terminalScrollbackPersist: 'no' }).enabled).toBe(SCROLLBACK_PERSIST_DEFAULT);
        expect(resolveScrollbackConfig({ terminalScrollbackPersist: false }).enabled).toBe(false);
        expect(resolveScrollbackConfig({ terminalScrollbackPersist: true }).enabled).toBe(true);
    });
});

// ── replay, rendered ────────────────────────────────────────────────────────

async function render(bytes: Buffer, cols: number, rows: number): Promise<HeadlessTerminal> {
    const term = new HeadlessTerminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
    await new Promise<void>((r) => term.write(bytes, r));
    return term;
}

function lineText(term: HeadlessTerminal, y: number): string {
    return term.buffer.active.getLine(y)?.translateToString(true) ?? '';
}

function findLine(term: HeadlessTerminal, needle: string): number {
    const buf = term.buffer.active;
    for (let y = 0; y < buf.length; y++) if (lineText(term, y).includes(needle)) return y;
    return -1;
}

function bgDefaultAt(term: HeadlessTerminal, y: number, x: number): boolean {
    return term.buffer.active.getLine(y)?.getCell(x)?.isBgDefault() === true;
}

describe('withArchivedScrollback', () => {
    const COLS = 40;
    const ROWS = 6;
    const pane: PaneState = { paneId: '%1', alternateOn: false, cursorX: 4, cursorY: 2, width: COLS, height: ROWS };
    const current = assembleRestore({
        history: b('cur-hist-1\ncur-hist-2\n'),
        smallHistory: b('cur-hist-2\n'),
        visible: b('$ ls\nfile\n$ x\n'),
        tail: Buffer.alloc(0),
    }, pane);

    it('no archive → payload is byte-identical', () => {
        expect(withArchivedScrollback(current, null)).toBe(current);
        expect(withArchivedScrollback(current, { savedAt: 1, body: Buffer.alloc(0) })).toBe(current);
    });

    it('only `full` changes; `small` and alternateOn are untouched', () => {
        const out = withArchivedScrollback(current, { savedAt: Date.now(), body: b('old') });
        expect(out.small.equals(current.small)).toBe(true);
        expect(out.alternateOn).toBe(current.alternateOn);
        expect(out.full.subarray(out.full.length - current.full.length).equals(current.full)).toBe(true);
        expect(s(out.full)).toContain(s(ARCHIVE_FOOTER_LINE));
    });

    it('archive sits above the current history between separators; screen + cursor unchanged', async () => {
        // An archive whose last row leaves a GREEN background open (B-288 shape).
        const archive = { savedAt: Date.now(), body: buildCheckpointBody([b('old-1\n\x1b[42mold-green-row\n')]) };
        const out = withArchivedScrollback(current, archive);
        const withA = await render(out.full, COLS, ROWS);
        const without = await render(current.full, COLS, ROWS);

        const head = findLine(withA, '以下为上次会话的输出');
        const old1 = findLine(withA, 'old-1');
        const oldGreen = findLine(withA, 'old-green-row');
        const foot = findLine(withA, '以上为上次会话的输出');
        const cur1 = findLine(withA, 'cur-hist-1');
        expect(head).toBeGreaterThanOrEqual(0);
        expect(head).toBeLessThan(old1);
        expect(old1).toBeLessThan(oldGreen);
        expect(oldGreen).toBeLessThan(foot);
        expect(foot).toBeLessThan(cur1);

        // The archived colour is preserved on its own row …
        expect(bgDefaultAt(withA, oldGreen, 0)).toBe(false);
        // … and does NOT leak into the separator or the current history.
        expect(bgDefaultAt(withA, foot, 0)).toBe(true);
        expect(bgDefaultAt(withA, foot, COLS - 1)).toBe(true);
        expect(bgDefaultAt(withA, cur1, 0)).toBe(true);

        // The viewport (= the live screen) and the cursor are exactly as without
        // an archive: the screen still owns the last `rows` rows.
        const vp = (t: HeadlessTerminal) => Array.from({ length: ROWS }, (_, i) => lineText(t, t.buffer.active.baseY + i));
        expect(vp(withA)).toEqual(vp(without));
        expect(withA.buffer.active.cursorX).toBe(without.buffer.active.cursorX);
        expect(withA.buffer.active.cursorY).toBe(without.buffer.active.cursorY);
        expect(withA.buffer.active.cursorY).toBe(2);
        expect(withA.buffer.active.cursorX).toBe(4);
    });

    it('alt-screen payload: archive stays in the normal buffer, alt frame still painted', async () => {
        const alt = assembleRestore({
            history: b('h\n'), altSaved: b('saved\n'), visible: b('VIM-FRAME\n'), tail: Buffer.alloc(0),
        }, { ...pane, alternateOn: true });
        const out = withArchivedScrollback(alt, { savedAt: Date.now(), body: b('old-archive') });
        const term = await render(out.full, COLS, ROWS);
        expect(term.buffer.active.type).toBe('alternate');
        expect(lineText(term, 0)).toContain('VIM-FRAME');
        const normal = term.buffer.normal;
        const texts = Array.from({ length: normal.length }, (_, y) => normal.getLine(y)?.translateToString(true) ?? '');
        expect(texts.findIndex((t) => t.includes('old-archive'))).toBeLessThan(texts.findIndex((t) => t.includes('saved')));
    });
});

// ── tick planning ───────────────────────────────────────────────────────────

describe('parseCheckpointProbe', () => {
    it('keeps vh sessions, skips attach terminals, foreign and malformed lines', () => {
        const out = parseCheckpointProbe([
            'vh-abc|1700000000|0|',
            'vh-alt1|1700000001|1|',
            'vh-att|1700000002|0|work',
            'mysession|1700000003|0|',
            'vh-bad id|1700000004|0|',
            'vh-noact||0|',
            'garbage',
            '',
        ].join('\n'));
        expect(out).toEqual([
            { id: 'abc', activityAt: 1_700_000_000_000, alternateOn: false },
            { id: 'alt1', activityAt: 1_700_000_001_000, alternateOn: true },
        ]);
    });
});

describe('planCheckpoints', () => {
    const NOW = 10_000_000;
    it('quiet + interval elapsed → due; still printing → not yet', () => {
        const due = planCheckpoints([
            { id: 'quiet', activityAt: NOW - CHECKPOINT_QUIET_MS, alternateOn: false },
            { id: 'busy', activityAt: NOW - 500, alternateOn: false },
        ], new Map([['busy', { at: NOW - 60_000 }]]), NOW);
        expect(due).toEqual(['quiet']);
    });

    it('clean terminals are skipped', () => {
        expect(planCheckpoints([{ id: 'a', activityAt: 5_000, alternateOn: false }], new Map([['a', { at: 6_000 }]]), NOW)).toEqual([]);
    });

    it('output in the same activity second as the capture start stays dirty (1s resolution)', () => {
        // activity stamped second 5 (= [5000, 6000)), capture started at 5400:
        // output at 5700 is not in it.
        const due = planCheckpoints([{ id: 'a', activityAt: 5_000, alternateOn: false }], new Map([['a', { at: 5_400 }]]), NOW,
            { minIntervalMs: 0 });
        expect(due).toEqual(['a']);
    });

    it('respects the minimum interval, but a never-quiet terminal is taken when overdue', () => {
        const state = new Map([
            ['recent', { at: NOW - CHECKPOINT_MIN_INTERVAL_MS + 1 }],
            ['spinner', { at: NOW - CHECKPOINT_MAX_DIRTY_MS }],
        ]);
        expect(planCheckpoints([
            { id: 'recent', activityAt: NOW - 10_000, alternateOn: false },
            { id: 'spinner', activityAt: NOW - 100, alternateOn: false },
        ], state, NOW)).toEqual(['spinner']);
    });

    it('oldest checkpoint first, capped per tick', () => {
        const ts = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, activityAt: NOW - 40_000, alternateOn: false }));
        const state = new Map([
            ['a', { at: NOW - 50_000 }],
            ['b', { at: NOW - 90_000 }],
        ]);
        expect(planCheckpoints(ts, state, NOW, { max: 3 })).toEqual(['c', 'd', 'e']);
        expect(planCheckpoints(ts, state, NOW, { max: 10 })).toEqual(['c', 'd', 'e', 'b', 'a']);
    });
});

describe('checkpointCaptureArgs', () => {
    it('normal screen: one capture of history + screen with the lines-channel flags', () => {
        expect(checkpointCaptureArgs('abc', false, 5000)).toEqual([['capture-pane', '-peqJN', '-t', '=vh-abc:', '-S', '-5000']]);
    });
    it('alt screen: history then the saved normal screen, never the alt frame', () => {
        expect(checkpointCaptureArgs('abc', true, 5000)).toEqual([
            ['capture-pane', '-peqJN', '-t', '=vh-abc:', '-S', '-5000', '-E', '-1'],
            ['capture-pane', '-peqJN', '-t', '=vh-abc:', '-a'],
        ]);
    });
});

describe('planScrollbackGc', () => {
    const NOW = 1_000_000_000_000;
    const f = (name: string, mtimeMs: number, bytes = 10): ArchiveFileEntry => {
        const p = parseArchiveFileName(name);
        return { name, id: p?.id ?? null, kind: p?.kind ?? null, mtimeMs, bytes };
    };
    it('foreign names, TTL and non-members go; members stay', () => {
        const doomed = planScrollbackGc([
            f('keep.live.vhsb', NOW - 1000),
            f('keep.prev.vhsb', NOW - 1000),
            f('gone.live.vhsb', NOW - 1000),
            f('old.prev.vhsb', NOW - SCROLLBACK_TTL_MS - 1),
            f('keep.live.vhsb.4242.tmp', NOW),
        ], new Set(['keep', 'old']), NOW);
        expect(doomed.sort()).toEqual(['gone.live.vhsb', 'keep.live.vhsb.4242.tmp', 'old.prev.vhsb']);
    });

    it('unknown membership (probe failed) never deletes by membership', () => {
        expect(planScrollbackGc([f('x.live.vhsb', NOW - 1000)], null, NOW)).toEqual([]);
    });

    it('total cap evicts oldest first', () => {
        const doomed = planScrollbackGc([
            f('a.live.vhsb', NOW - 3000, 40),
            f('b.live.vhsb', NOW - 2000, 40),
            f('c.live.vhsb', NOW - 1000, 40),
        ], null, NOW, SCROLLBACK_TTL_MS, 90);
        expect(doomed).toEqual(['a.live.vhsb']);
    });
});
