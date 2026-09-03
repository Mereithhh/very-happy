import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

/**
 * B-309 behaviour, not source text: while a turn runs, the web must show the
 * text as it arrives — the failure this replaces was a 30-second spinner
 * followed by an entire assistant message appearing at once.
 *
 * Components are imported lazily so browser globals exist first (see
 * `@/testing/browserTestGlobals`).
 */
let LiveStreamBlocks: typeof import('./LiveStreamView').LiveStreamBlocks;
let applyStreamFrame: typeof import('@/sync/liveStream').applyStreamFrame;
let claimStreamKeys: typeof import('@/sync/liveStream').claimStreamKeys;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ LiveStreamBlocks } = await import('./LiveStreamView'));
    ({ applyStreamFrame, claimStreamKeys } = await import('@/sync/liveStream'));
});

function render(node: React.ReactNode): string {
    return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

/** Fold frames the way the socket handler does, then hand the result to the
 *  presentational component (zustand's SSR snapshot is the initial state, so a
 *  store-reading component renders empty here). */
function draft(frames: any[]) {
    return frames.reduce((state: any, frame: any) => applyStreamFrame(state, frame, Date.now()), undefined);
}

describe('LiveStreamView', () => {
    it('renders nothing when no turn is streaming', () => {
        expect(render(<LiveStreamBlocks blocks={[]} />)).toBe('');
    });

    it('paints thinking text as it arrives, expanded, with a caret on the live block', () => {
        const state = draft([
            { t: 'block-start', mid: 'm1', idx: 0, kind: 'thinking' },
            { t: 'block-delta', mid: 'm1', idx: 0, text: 'Checking the config' },
        ]);
        const html = render(<LiveStreamBlocks blocks={state.blocks} />);

        expect(html).toContain('Checking the config');
        // Expanded, not the collapsed "Thought for Ns" disclosure: the point
        // is watching it arrive.
        expect(html).toContain('msg-thinking-body');
        // no `hidden` attribute on a container (aria-hidden on the icon is fine)
        expect(html).not.toMatch(/<div[^>]*\shidden\b/);
        expect(html).toContain('ls-cursor');
    });

    it('drops the caret once the block ends but keeps the text until it is claimed', () => {
        const state = draft([
            { t: 'block-start', mid: 'm1', idx: 0, kind: 'text' },
            { t: 'block-delta', mid: 'm1', idx: 0, text: 'Done.' },
            { t: 'block-end', mid: 'm1', idx: 0 },
        ]);
        const html = render(<LiveStreamBlocks blocks={state.blocks} />);

        expect(html).toContain('Done.');
        expect(html).not.toContain('ls-cursor');
    });

    it('carets only the last block when thinking is followed by an answer', () => {
        const state = draft([
            { t: 'block-start', mid: 'm1', idx: 0, kind: 'thinking' },
            { t: 'block-delta', mid: 'm1', idx: 0, text: 'reasoning' },
            { t: 'block-end', mid: 'm1', idx: 0 },
            { t: 'block-start', mid: 'm1', idx: 1, kind: 'text' },
            { t: 'block-delta', mid: 'm1', idx: 1, text: 'answer' },
        ]);
        const html = render(<LiveStreamBlocks blocks={state.blocks} />);

        expect(html).toContain('reasoning');
        expect(html).toContain('answer');
        expect(html.match(/ls-cursor/g)).toHaveLength(1);
    });

    it('disappears the moment the persisted message claims the draft', () => {
        const state = draft([
            { t: 'block-start', mid: 'm1', idx: 0, kind: 'text' },
            { t: 'block-delta', mid: 'm1', idx: 0, text: 'the answer' },
        ]);
        expect(render(<LiveStreamBlocks blocks={state.blocks} />)).toContain('the answer');

        const claimed = claimStreamKeys(state, ['m1:0'])!;
        // No intermediate state where both the draft and the real message
        // could be on screen — that flicker is what streamKey exists to avoid.
        expect(render(<LiveStreamBlocks blocks={claimed.blocks} />)).toBe('');
    });

    it('keeps drafts alive across turn-end, since the persisted message is still in flight', () => {
        const state = draft([
            { t: 'block-start', mid: 'm1', idx: 0, kind: 'text' },
            { t: 'block-delta', mid: 'm1', idx: 0, text: 'still here' },
            { t: 'turn-end' },
        ]);
        expect(render(<LiveStreamBlocks blocks={state.blocks} />)).toContain('still here');
    });

    it('renders nothing for a block that has started but has no text yet', () => {
        const state = draft([{ t: 'block-start', mid: 'm1', idx: 0, kind: 'text' }]);
        expect(render(<LiveStreamBlocks blocks={state.blocks} />)).toBe('');
    });
});
