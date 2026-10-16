// @vitest-environment happy-dom
/**
 * B-607 regression (Owner 2026-10-16, veryhappy.dev): scrolled up in a
 * session while the agent worked, a new message arrived and the transcript
 * jumped to the very top.
 *
 * Mechanism (reproduced in real Chromium + WebKit on /dev/chat-scroll with
 * `fresh=1`, see the PR): the reader is inside the LIVE turn's activity,
 * which is expanded while the turn runs. Liveness drops (turn-end message,
 * thinking lease) → TurnActivityView folds the whole turn on the live→done
 * edge → the content under the viewport is gone and the browser clamps
 * scrollTop. On a live→done→live flicker it unfolds again right away, but the
 * clamped scrollTop now points at the start of the turn — scrollTop 1782 → 34
 * when that turn is the whole transcript.
 *
 * Rule: the finished turn folds only when the reader follows the live end or
 * the fold happens entirely below the viewport.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/ui', () => ({ StatusDot: () => null }));
vi.mock('./ActivityMessages', () => ({ ActivityMessages: () => <div className="ta-steps" /> }));
vi.mock('./useElapsed', () => ({ useElapsedSeconds: () => 0 }));
import { TurnActivityView } from './TurnActivityView';
import { ReaderFollowContext } from './readerFollow';
import { shouldFoldFinishedTurn } from './chatFollow';
import type { Message } from '@/sync/typesMessage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW_BOTTOM = 600;
const messages = [{ kind: 'agent-text', id: 'a1', localId: null, createdAt: 1, text: 'step' }] as unknown as Message[];

let host: HTMLDivElement;
let root: Root;
let following = false;
let panelTop = 0;
let restoreRect = () => {};

beforeEach(() => {
    following = false;
    panelTop = 0;
    const rect = HTMLElement.prototype.getBoundingClientRect;
    restoreRect = () => { HTMLElement.prototype.getBoundingClientRect = rect; };
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        const box = rect.call(this);
        if (this.classList.contains('cl-scroll')) return { ...box.toJSON(), top: 0, bottom: VIEW_BOTTOM, height: VIEW_BOTTOM } as DOMRect;
        if (this.classList.contains('ta-detail')) return { ...box.toJSON(), top: panelTop, bottom: panelTop + 3000, height: 3000 } as DOMRect;
        return box;
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    restoreRect();
});

function render(live: boolean): void {
    const tree: ReactNode = (
        <ReaderFollowContext.Provider value={() => following}>
            <div className="cl-scroll">
                <TurnActivityView messages={messages} live={live} sessionId="s" />
            </div>
        </ReaderFollowContext.Provider>
    );
    act(() => root.render(tree));
}
const expanded = () => host.querySelector('.ta-detail') !== null;

describe('B-607 a finished turn does not fold out from under its reader', () => {
    it('reader scrolled up into the live turn: turn ends → stays expanded', () => {
        render(true);
        expect(expanded()).toBe(true);
        panelTop = -1200; // the reader is 1200px into the turn's steps
        render(false);
        expect(expanded()).toBe(true);
    });

    it('live → done → live flicker never takes the steps out of the DOM (scrollTop is never clamped)', () => {
        render(true);
        const steps = host.querySelector('.ta-steps');
        panelTop = -1200;
        render(false);
        render(true);
        expect(host.querySelector('.ta-steps')).toBe(steps);
    });

    it('reader following the live end: the done turn folds as before', () => {
        render(true);
        following = true;
        panelTop = -1200;
        render(false);
        expect(expanded()).toBe(false);
    });

    it('turn entirely below a detached reader: it folds (nothing moves above them)', () => {
        render(true);
        panelTop = VIEW_BOTTOM + 40;
        render(false);
        expect(expanded()).toBe(false);
    });

    it('a turn the reader kept open can still be folded by hand', () => {
        render(true);
        panelTop = -1200;
        render(false);
        act(() => { host.querySelector<HTMLButtonElement>('.ta-head')!.click(); });
        expect(expanded()).toBe(false);
    });
});

describe('shouldFoldFinishedTurn', () => {
    it('folds when following, or when the panel starts at/below the viewport bottom', () => {
        expect(shouldFoldFinishedTurn({ following: true, panelTop: -500, viewportBottom: 600 })).toBe(true);
        expect(shouldFoldFinishedTurn({ following: false, panelTop: 600, viewportBottom: 600 })).toBe(true);
        expect(shouldFoldFinishedTurn({ following: false, panelTop: null, viewportBottom: 600 })).toBe(true);
    });
    it('keeps it open when the panel reaches into or above the viewport of a detached reader', () => {
        expect(shouldFoldFinishedTurn({ following: false, panelTop: 599, viewportBottom: 600 })).toBe(false);
        expect(shouldFoldFinishedTurn({ following: false, panelTop: -2000, viewportBottom: 600 })).toBe(false);
    });
});
