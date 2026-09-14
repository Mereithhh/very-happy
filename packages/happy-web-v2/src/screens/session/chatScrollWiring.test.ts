import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

// B-467: a nested vertical scroller inside the transcript must let the wheel
// chain to `.cl-scroll` once it hits its own edge. `overscroll-behavior:
// contain` blocks that chaining, and with the pointer resting on a tall command
// output at its top the whole conversation would not scroll up (measured 0px
// over 20 wheel ticks in real Chromium; 1200px once removed). Only the
// transcript scroller itself (which contains against the body) and modal
// overlays may contain.
describe('nested scrollers inside the transcript chain to the transcript', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const allowed = new Set(['.cl-scroll', '.runtime-body']);
    it('no transcript css rule sets overscroll-behavior: contain outside the allowlist', () => {
        const offenders: string[] = [];
        for (const file of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
            const text = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
            for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
                if (!/overscroll-behavior\s*:\s*contain/.test(m[2])) continue;
                const selector = m[1].trim().split('\n').pop()!.trim();
                if (!allowed.has(selector)) offenders.push(`${file}: ${selector}`);
            }
        }
        expect(offenders).toEqual([]);
    });
    it('command output scrolls inside itself but chains at its edges', () => {
        const command = readFileSync(join(dir, 'command.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        const out = command.match(/\.cmd-out \{([^}]+)\}/)?.[1] ?? '';
        expect(out).toContain('max-height: 360px;');
        expect(out).toContain('overflow: auto;');
        expect(out).toContain('overscroll-behavior: auto;');
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
