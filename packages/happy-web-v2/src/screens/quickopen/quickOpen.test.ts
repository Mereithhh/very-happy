import { describe, expect, it } from 'vitest';
import { highlightRuns, rankQuickOpen, scoreQuickOpen } from './quickOpenScore';
import { QUICK_OPEN_HISTORY_KEY, QUICK_OPEN_HISTORY_LIMIT, readQuickOpenHistory, recordQuickOpen } from './quickOpenHistory';

const FILES = [
    'README.md',
    'docs/backlog.md',
    'packages/happy-web-v2/src/screens/terminal/WebTerminalScreen.tsx',
    'packages/happy-web-v2/src/screens/terminal/termSearch.ts',
    'packages/happy-web-v2/src/screens/session/SessionDetailScreen.tsx',
    'packages/happy-cli/src/terminal/webTerminal.ts',
    'src/terminal/index.ts',
];

const top = (q: string, history: string[] = []) => rankQuickOpen(q, FILES, history).map((m) => m.path);

describe('scoreQuickOpen (B-576)', () => {
    it('rejects non-subsequences', () => {
        expect(scoreQuickOpen('xyz', 'README.md')).toBeNull();
        expect(scoreQuickOpen('dmr', 'README.md')).toBeNull(); // order matters
    });

    it('a file-name match beats a match that needs the directories', () => {
        // "term" is in the name of termSearch.ts but only in the dirs of index.ts
        const ranked = top('term');
        expect(ranked.indexOf('packages/happy-web-v2/src/screens/terminal/termSearch.ts'))
            .toBeLessThan(ranked.indexOf('src/terminal/index.ts'));
    });

    it('consecutive matches beat scattered ones', () => {
        const contiguous = scoreQuickOpen('web', 'a/webTerminal.ts')!;
        const scattered = scoreQuickOpen('web', 'a/wxexb.ts')!;
        expect(contiguous.score).toBeGreaterThan(scattered.score);
    });

    it('word starts / camelCase humps score (wts → WebTerminalScreen)', () => {
        expect(top('wts')[0]).toBe('packages/happy-web-v2/src/screens/terminal/WebTerminalScreen.tsx');
    });

    it('a query with / matches across the whole path', () => {
        expect(top('cli/web')[0]).toBe('packages/happy-cli/src/terminal/webTerminal.ts');
    });

    it('is case-insensitive and ignores spaces', () => {
        expect(top('read me')[0]).toBe('README.md');
    });

    it('returns highlight positions that point at the matched chars', () => {
        const m = scoreQuickOpen('bl', 'docs/backlog.md')!;
        expect(m.positions.map((i) => 'docs/backlog.md'[i]).join('')).toBe('bl');
        expect(highlightRuns('backlog.md', m.positions, 5)).toEqual([
            { text: 'b', hit: true }, { text: 'ack', hit: false }, { text: 'l', hit: true }, { text: 'og.md', hit: false },
        ]);
    });
});

describe('rankQuickOpen history', () => {
    it('empty query: recent files first (most recent first), then list order; stale history dropped', () => {
        const ranked = top('', ['docs/backlog.md', 'gone.ts', 'src/terminal/index.ts']);
        expect(ranked.slice(0, 3)).toEqual(['docs/backlog.md', 'src/terminal/index.ts', 'README.md']);
        expect(ranked).not.toContain('gone.ts');
        expect(new Set(ranked).size).toBe(ranked.length);
    });

    it('recency breaks near-ties but never lifts a dir match over a name match', () => {
        const withHistory = top('index', ['src/terminal/index.ts']);
        expect(withHistory[0]).toBe('src/terminal/index.ts');
        const nameVsDir = top('term', ['src/terminal/index.ts']);
        expect(nameVsDir.indexOf('src/terminal/index.ts'))
            .toBeGreaterThan(nameVsDir.indexOf('packages/happy-web-v2/src/screens/terminal/termSearch.ts'));
    });

    it('respects the limit', () => {
        expect(rankQuickOpen('', FILES, [], 3)).toHaveLength(3);
        expect(rankQuickOpen('s', FILES, [], 2)).toHaveLength(2);
    });
});

function memStorage(initial: Record<string, string> = {}) {
    const data = { ...initial };
    return {
        data,
        getItem: (k: string) => (k in data ? data[k] : null),
        setItem: (k: string, v: string) => { data[k] = v; },
    };
}

describe('quickOpenHistory', () => {
    it('records most-recent-first, deduped, capped', () => {
        const s = memStorage();
        recordQuickOpen('m:/p', 'a.ts', s);
        recordQuickOpen('m:/p', 'b.ts', s);
        recordQuickOpen('m:/p', 'a.ts', s);
        expect(readQuickOpenHistory('m:/p', s)).toEqual(['a.ts', 'b.ts']);
        for (let i = 0; i < 30; i++) recordQuickOpen('m:/p', `f${i}.ts`, s);
        expect(readQuickOpenHistory('m:/p', s)).toHaveLength(QUICK_OPEN_HISTORY_LIMIT);
        expect(readQuickOpenHistory('other', s)).toEqual([]);
    });

    it('throwing / missing / corrupt storage reads as empty and never throws', () => {
        const throwing = {
            getItem: () => { throw new Error('SecurityError'); },
            setItem: () => { throw new Error('QuotaExceeded'); },
        };
        expect(readQuickOpenHistory('p', throwing)).toEqual([]);
        expect(recordQuickOpen('p', 'a.ts', throwing)).toEqual(['a.ts']);
        expect(readQuickOpenHistory('p', null)).toEqual([]);
        expect(readQuickOpenHistory('p', memStorage({ [QUICK_OPEN_HISTORY_KEY]: '{not json' }))).toEqual([]);
        expect(readQuickOpenHistory('p', memStorage({ [QUICK_OPEN_HISTORY_KEY]: '{"p":[1,"x.ts",null]}' }))).toEqual(['x.ts']);
    });
});

import { matchQuickOpenChord } from './quickOpenEvents';

describe('matchQuickOpenChord', () => {
    const k = (o: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string }>) =>
        ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, code: 'KeyP', ...o });
    it('mac: ⌘P only (Ctrl+P stays readline previous-history)', () => {
        expect(matchQuickOpenChord(k({ metaKey: true }), true)).toBe(true);
        expect(matchQuickOpenChord(k({ ctrlKey: true }), true)).toBe(false);
        expect(matchQuickOpenChord(k({ metaKey: true, shiftKey: true }), true)).toBe(false);
    });
    it('others: Ctrl+P; layout-independent code', () => {
        expect(matchQuickOpenChord(k({ ctrlKey: true }), false)).toBe(true);
        expect(matchQuickOpenChord(k({ ctrlKey: true, altKey: true }), false)).toBe(false);
        expect(matchQuickOpenChord(k({ ctrlKey: true, code: 'KeyO' }), false)).toBe(false);
    });
});

import { createQuickOpenRanker } from './quickOpenScore';

describe('createQuickOpenRanker (incremental narrowing)', () => {
    it('a growing query rescans only the previous matches and ranks like a full scan', () => {
        const rank = createQuickOpenRanker();
        const many = [...FILES, ...Array.from({ length: 200 }, (_, i) => `gen/file${i}.txt`)];
        rank('t', many, []);
        const firstPool = rank.lastPoolSize;
        expect(firstPool).toBe(many.length);
        const narrowed = rank('te', many, []);
        expect(rank.lastPoolSize).toBeLessThan(firstPool);
        expect(narrowed.map((m) => m.path)).toEqual(rankQuickOpen('te', many, []).map((m) => m.path));
        const deeper = rank('term', many, []);
        expect(deeper.map((m) => m.path)).toEqual(rankQuickOpen('term', many, []).map((m) => m.path));
    });
    it('backspace, a different query or a new file list falls back to a full scan', () => {
        const rank = createQuickOpenRanker();
        rank('term', FILES, []);
        rank('ter', FILES, []);
        expect(rank.lastPoolSize).toBe(FILES.length);
        rank('read', FILES, []);
        expect(rank.lastPoolSize).toBe(FILES.length);
        rank('reado', FILES, []);
        const other = [...FILES];
        rank('readme', other, []);
        expect(rank.lastPoolSize).toBe(other.length);
    });
});
