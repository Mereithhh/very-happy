// @vitest-environment happy-dom
/**
 * B-897 regression: a folded finished turn that goes live again (liveness
 * flicker, the agent continuing the same turn) must be open in the SAME commit.
 *
 * Measured (Chromium, production build, 540-message session, reader pinned to
 * the bottom): the row first committed folded (32px) with the answer already
 * moved inside it, the browser clamped scrollTop 607px up, the expansion only
 * landed from the effect after paint, and the clamp's scroll event read as the
 * reader leaving — the reply then grew below a view parked ~1500–3000px up.
 */
import { act, useLayoutEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/ui', () => ({ StatusDot: () => null }));
vi.mock('./ActivityMessages', () => ({ ActivityMessages: () => <div className="ta-steps" /> }));
vi.mock('./useElapsed', () => ({ useElapsedSeconds: () => 0 }));
import { TurnActivityView } from './TurnActivityView';
import { ReaderFollowContext, createReaderFollow } from './readerFollow';
import type { Message } from '@/sync/typesMessage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const messages = [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'step' }] as unknown as Message[];
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

/** Records, at every commit's layout phase (where ChatList measures and the browser lays out), whether the turn is open. */
const commits: boolean[] = [];
function CommitProbe() {
    useLayoutEffect(() => { commits.push(host.querySelector('.ta-detail') !== null); });
    return null;
}

function render(live: boolean): void {
    const reader = createReaderFollow(true);
    const tree: ReactNode = (
        <ReaderFollowContext.Provider value={reader}>
            <div className="cl-scroll">
                <TurnActivityView messages={messages} live={live} sessionId="s" />
                <CommitProbe />
            </div>
        </ReaderFollowContext.Provider>
    );
    act(() => root.render(tree));
}

describe('B-897 a folded turn that goes live again opens before it is laid out', () => {
    it('finished (folded) → live: every commit shows it open', () => {
        render(true);
        render(false);
        expect(host.querySelector('.ta-detail')).toBeNull(); // folded while following
        commits.length = 0;
        render(true);
        expect(commits.length).toBeGreaterThan(0);
        expect(commits).not.toContain(false);
    });

    it('opened live from the start, and still folds when it finishes under a following reader', () => {
        commits.length = 0;
        render(true);
        expect(commits).not.toContain(false);
        render(false);
        expect(host.querySelector('.ta-detail')).toBeNull();
    });
});
