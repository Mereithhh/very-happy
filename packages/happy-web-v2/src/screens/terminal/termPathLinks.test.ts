import { describe, expect, it } from 'vitest';
import {
    findPathCandidates,
    isPathLike,
    isPathOpenClick,
    isPathTapGesture,
    isStrongTouchPath,
    pathAtCell,
    pathLinksOnRow,
    resolveTerminalPath,
} from './termPathLinks';
import type { SearchBufferLike, SearchLineLike } from './termSearch';

const WIDE = /[一-鿿]/;
function fakeLine(text: string, cols: number, isWrapped = false): SearchLineLike {
    const cells: Array<{ chars: string; width: number }> = [];
    for (const ch of text) {
        if (WIDE.test(ch)) cells.push({ chars: ch, width: 2 }, { chars: '', width: 0 });
        else cells.push({ chars: ch, width: 1 });
    }
    while (cells.length < cols) cells.push({ chars: '', width: 1 });
    return {
        isWrapped,
        length: cols,
        translateToString(trimRight?: boolean) {
            let s = '';
            for (const c of cells) if (c.width !== 0) s += c.chars || ' ';
            return trimRight ? s.replace(/ +$/, '') : s;
        },
        getCell(x: number) {
            const c = cells[x];
            return c ? { getChars: () => c.chars, getWidth: () => c.width } : undefined;
        },
    };
}
const fakeBuffer = (lines: SearchLineLike[]): SearchBufferLike => ({ length: lines.length, getLine: (y) => lines[y] });

const paths = (text: string) => findPathCandidates(text).map((c) => [c.pathText, c.line, c.col]);

describe('findPathCandidates (B-574①)', () => {
    it('absolute, home, dot-relative, relative and bare file names', () => {
        expect(paths('open /etc/hosts now')).toEqual([['/etc/hosts', null, null]]);
        expect(paths('see ~/notes/todo.md')).toEqual([['~/notes/todo.md', null, null]]);
        expect(paths('./run.sh and ../lib/x.ts')).toEqual([['./run.sh', null, null], ['../lib/x.ts', null, null]]);
        expect(paths('edited src/app/main.tsx')).toEqual([['src/app/main.tsx', null, null]]);
        expect(paths('read README.md first')).toEqual([['README.md', null, null]]);
        expect(paths('cat .env')).toEqual([['.env', null, null]]);
    });

    it('path:line and path:line:col', () => {
        expect(paths('src/a.ts:12:3 - error')).toEqual([['src/a.ts', 12, 3]]);
        expect(paths('at index.ts:40')).toEqual([['index.ts', 40, null]]);
    });

    it('strips wrapping punctuation and sentence dots', () => {
        expect(paths('⏺ Update(src/foo.ts)')).toEqual([['src/foo.ts', null, null]]);
        expect(paths('see "docs/a.md", then [b/c.md].')).toEqual([['docs/a.md', null, null], ['b/c.md', null, null]]);
        expect(paths('look at src/x.ts.')).toEqual([['src/x.ts', null, null]]);
        expect(findPathCandidates('look at src/x.ts.')[0]).toMatchObject({ start: 8, end: 16 });
    });

    it('leaves URLs to WebLinksAddon, but turns file:// into a path', () => {
        expect(paths('https://github.com/a/b.ts and http://x.io/y')).toEqual([]);
        expect(paths('file:///Users/me/a.ts#L7')).toEqual([['/Users/me/a.ts', 7, null]]);
        expect(paths('file:///tmp/x.log:3:2')).toEqual([['/tmp/x.log', 3, 2]]);
    });

    it('ignores versions, times, fractions, directories and prose abbreviations', () => {
        expect(paths('v1.2.3 at 12:30:45 is 1/2 of e.g. the src/ dir')).toEqual([]);
        expect(paths('just words here')).toEqual([]);
        expect(isPathLike('a//b')).toBe(false);
        expect(isPathLike('~')).toBe(false);
    });

    it('accepts CJK names', () => {
        expect(paths('写入 文档/说明.md 了')).toEqual([['文档/说明.md', null, null]]);
    });
});

describe('resolveTerminalPath', () => {
    it('keeps absolute and ~ paths (normalized)', () => {
        expect(resolveTerminalPath('/a/./b/../c.ts', '/x')).toBe('/a/c.ts');
        expect(resolveTerminalPath('~/a/../b.md', null)).toBe('~/b.md');
    });
    it('resolves relative paths against the terminal cwd, never HOME', () => {
        expect(resolveTerminalPath('src/a.ts', '/repo')).toBe('/repo/src/a.ts');
        expect(resolveTerminalPath('./a.ts', '/repo/')).toBe('/repo/a.ts');
        expect(resolveTerminalPath('../up.ts', '/repo/sub')).toBe('/repo/up.ts');
        expect(resolveTerminalPath('a.ts', '~/proj')).toBe('~/proj/a.ts');
        expect(resolveTerminalPath('a.ts', undefined)).toBeNull();
        expect(resolveTerminalPath('a.ts', 'relative/cwd')).toBeNull();
    });
});

describe('buffer mapping', () => {
    it('maps a path to 1-based inclusive xterm ranges', () => {
        const buf = fakeBuffer([fakeLine('x src/a.ts:3 y', 20)]);
        const links = pathLinksOnRow(buf, 0);
        expect(links).toHaveLength(1);
        expect(links[0].range).toEqual({ start: { x: 3, y: 1 }, end: { x: 12, y: 1 } });
    });

    it('joins soft wraps: a path split across two rows is one link on both rows', () => {
        const buf = fakeBuffer([fakeLine('see src/long/pa', 15), fakeLine('th.ts ok', 15, true)]);
        const top = pathLinksOnRow(buf, 0);
        const bottom = pathLinksOnRow(buf, 1);
        expect(top[0].candidate.pathText).toBe('src/long/path.ts');
        expect(top[0].range).toEqual({ start: { x: 5, y: 1 }, end: { x: 5, y: 2 } });
        expect(bottom[0].range).toEqual(top[0].range);
    });

    it('wide characters shift the cell columns', () => {
        const buf = fakeBuffer([fakeLine('中文 a/b.ts', 20)]);
        expect(pathLinksOnRow(buf, 0)[0].range).toEqual({ start: { x: 6, y: 1 }, end: { x: 11, y: 1 } });
        expect(pathAtCell(buf, 0, 5)?.pathText).toBe('a/b.ts');
        expect(pathAtCell(buf, 0, 1)).toBeNull();
    });

    it('a tap off the path (or past the line end) finds nothing', () => {
        const buf = fakeBuffer([fakeLine('ok src/a.ts', 30)]);
        expect(pathAtCell(buf, 0, 3)?.pathText).toBe('src/a.ts');
        expect(pathAtCell(buf, 0, 0)).toBeNull();
        expect(pathAtCell(buf, 0, 25)).toBeNull();
        expect(pathAtCell(buf, 5, 0)).toBeNull();
    });
});

describe('gestures', () => {
    it('desktop needs the platform modifier', () => {
        expect(isPathOpenClick({ metaKey: true, ctrlKey: false }, true)).toBe(true);
        expect(isPathOpenClick({ metaKey: false, ctrlKey: true }, true)).toBe(false);
        expect(isPathOpenClick({ metaKey: false, ctrlKey: true }, false)).toBe(true);
        expect(isPathOpenClick({ metaKey: false, ctrlKey: false }, false)).toBe(false);
    });
    it('touch: only a short, still tap with no selection and not in select mode', () => {
        const tap = { selectMode: false, distanceSquared: 4, durationMs: 120, hasDomSelection: false, hasTermSelection: false, scrolled: false, flingAtStart: false, multiTouch: false };
        expect(isPathTapGesture(tap)).toBe(true);
        expect(isPathTapGesture({ ...tap, durationMs: 650 })).toBe(false); // long press = native selection
        expect(isPathTapGesture({ ...tap, distanceSquared: 200 })).toBe(false);
        expect(isPathTapGesture({ ...tap, selectMode: true })).toBe(false);
        expect(isPathTapGesture({ ...tap, hasDomSelection: true })).toBe(false);
        expect(isPathTapGesture({ ...tap, hasTermSelection: true })).toBe(false);
        expect(isPathTapGesture({ ...tap, scrolled: true })).toBe(false); // gesture became a scroll
        expect(isPathTapGesture({ ...tap, flingAtStart: true })).toBe(false); // tap only stopped momentum
        expect(isPathTapGesture({ ...tap, multiTouch: true })).toBe(false); // pinch lift
    });
});

describe('touch: only strong paths take the tap from the keyboard', () => {
    const cand = (text: string) => findPathCandidates(text)[0] ?? null;
    const none = () => false;
    it('prose look-alikes are not consumed', () => {
        // Node.js / www.example.com: bare names unknown to the project
        expect(isStrongTouchPath(cand('use Node.js now')!, none)).toBe(false);
        expect(isStrongTouchPath(cand('www.example.com')!, none)).toBe(false);
        // and/or: a slash but no file-like last segment
        expect(isStrongTouchPath(cand('this and/or that')!, none)).toBe(false);
        // e-mail is not even a candidate
        expect(cand('mail a@b.com')).toBeNull();
    });
    it('explicit roots, :line and relative paths with an extension are strong', () => {
        expect(isStrongTouchPath(cand('/etc/hosts')!, none)).toBe(true);
        expect(isStrongTouchPath(cand('~/notes/todo')!, none)).toBe(true);
        expect(isStrongTouchPath(cand('./run')!, none)).toBe(true);
        expect(isStrongTouchPath(cand('index.ts:40')!, none)).toBe(true);
        expect(isStrongTouchPath(cand('src/app/main.ts')!, none)).toBe(true);
    });
    it('a bare name counts only when the project list knows it', () => {
        const known = (n: string) => n === 'README.md';
        expect(isStrongTouchPath(cand('README.md')!, known)).toBe(true);
        expect(isStrongTouchPath(cand('Node.js')!, known)).toBe(false);
    });
});
