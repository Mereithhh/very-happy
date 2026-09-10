import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const chat = readFileSync(new URL('./ChatList.tsx', import.meta.url), 'utf8');
const detail = readFileSync(new URL('./SessionDetailScreen.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./chatlist.css', import.meta.url), 'utf8');

describe('session-scoped transcript scrolling', () => {
    it('remounts the transcript by session and resets cached-session state before paint', () => {
        expect(detail).toContain('<ChatList key={id} sessionId={id}');
        expect(chat).toContain('useLayoutEffect(() => {\n        if (!isLoaded) return;');
        expect(chat).toContain('atBottomRef.current = true;');
        expect(chat).toContain('}, [sessionId, isLoaded]);');
    });

    it('uses native vertical touch scrolling without browser scroll anchoring fighting bottom-follow', () => {
        expect(css).toMatch(/\.cl-scroll \{[\s\S]*touch-action: pan-y;/);
        expect(css).toMatch(/\.cl-scroll \{[\s\S]*overflow-anchor: none;/);
    });
});

// Geometry is additionally measured by css-probe with a real 10px scrollbar.
describe('shared transcript and composer alignment', () => {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
    it('sizes and centers content against the full chat lane, excluding inset from the scrollable box', () => {
        const root = source.match(/\.cl \{([^}]+)\}/)?.[1] ?? '';
        const inner = source.match(/^\.cl-inner \{([^}]+)\}/m)?.[1] ?? '';
        expect(root).toContain('container-type: inline-size;');
        expect(root).toContain('--chat-content-inset: var(--sp-4);');
        expect(inner).toContain('width: calc(min(820px, 100cqi) - 2 * var(--chat-content-inset));');
        expect(inner).toContain('margin-inline-start: calc(max(0px, (100cqi - 820px) / 2) + var(--chat-content-inset));');
        expect(source).toMatch(/@media \(max-width: 600px\), \(pointer: coarse\) \{\s*\.cl \{ --chat-content-inset: var\(--sp-3\); \}/);
    });
});
