// @vitest-environment happy-dom
/**
 * Regression (Owner 2026-10-13, veryhappy.dev eccf6b55): scrolling up an idle
 * chat snapped back to the bottom. Cause: after a session opened, the (pre-
 * B-616) background prefetch prepended a page of OLDER history at the top
 * every ~250 ms. Each page bumps rows.length and grows `.cl-inner`;
 * ChatList treated both as "new content" and scrolled to the bottom whenever
 * the reader was still inside the 80 px follow band — so a slow (trackpad)
 * scroll-up was reset to 0 on every page and could never leave the band.
 * Real Chromium + real ChatList (/dev/chat-scroll, 4 px wheel steps during
 * prefetch): distance from bottom never exceeded 24 px before, 320 px after.
 *
 * Mounts the REAL ChatList on a fake store with scroll geometry stubbed
 * (100 px per row, 300 px viewport) and drives the prefetch sequence the way
 * sync.loadOlderMessages commits it.
 */
import { act, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Msg = { kind: string; id: string; text: string; createdAt: number; seq: number; localId: null };
const store = vi.hoisted(() => {
    let state = { messages: [] as unknown[], isLoaded: true, hasMoreOlder: true, isLoadingOlder: false };
    const listeners = new Set<() => void>();
    return {
        get: () => state,
        set: (patch: Partial<typeof state>) => { state = { ...state, ...patch }; for (const l of listeners) l(); },
        subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    };
});
vi.mock('@/sync/storage', () => ({
    useSession: () => ({ thinking: false, presence: 'online', metadata: {} }),
    useSessionMessages: () => useSyncExternalStore(store.subscribe, store.get),
}));
vi.mock('@/sync/sync', () => ({ sync: { loadOlderMessages: vi.fn() } }));
// B-766: not a team lead session (ChatList reads team membership for the lead view).
vi.mock('@/screens/sessions/useTeamNavigation', () => ({ useTeamNavigation: () => [] }));
vi.mock('@/sync/ops', () => ({ sessionCancelQueuedMessage: vi.fn() }));
vi.mock('@/sync/liveStreamStore', () => ({ endLiveStreamTurn: vi.fn(), useHasLiveDraft: () => false }));
vi.mock('@/sync/heartbeatLease', () => ({ useHeartbeatFresh: () => false }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/ui', () => ({ Button: () => null, EmptyState: () => null, OrbitLoader: () => null, Spinner: () => null, useToast: () => ({}) }));
vi.mock('./Markdown', () => ({ MarkdownPathProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('./MessageView', () => ({ MessageView: () => <div data-row="" /> }));
vi.mock('./ToolGroupView', () => ({ ToolGroupView: () => <div data-row="" /> }));
vi.mock('./TurnActivityView', () => ({ TurnActivityView: () => <div data-row="" /> }));
vi.mock('./TurnDiffRollup', () => ({ TurnDiffRollup: () => <div data-row="" /> }));
vi.mock('./CompactionDivider', () => ({ CompactionDivider: () => <div data-row="" /> }));
vi.mock('./LiveStreamView', () => ({ LiveStreamView: () => null }));
vi.mock('./PermissionCard', () => ({ PermissionPointer: () => null }));
vi.mock('./SessionLiveStatusBar', () => ({ SessionLiveStatusBar: () => null }));
vi.mock('./MessageTimeTooltip', () => ({ MessageTimeTooltip: () => null }));
vi.mock('./SelectionQuote', () => ({ SelectionQuote: () => null }));
vi.mock('./ChatPromptRail', () => ({ ChatPromptRail: () => null }));
import { ChatList } from './ChatList';
import { SCROLL_SETTLE_MS } from './chatFollow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROW = 100;
const VIEW = 300;

/** user/agent pairs, storage order (newest first). */
function messages(fromSeq: number, toSeq: number): Msg[] {
    const out: Msg[] = [];
    for (let seq = toSeq; seq >= fromSeq; seq--) {
        out.push({ kind: seq % 2 === 0 ? 'user-text' : 'agent-text', id: `m${seq}`, text: `t${seq}`, createdAt: seq, seq, localId: null });
    }
    return out;
}

// Manual ResizeObserver + rAF so the growth follower runs when the test says.
const observers: { cb: ResizeObserverCallback; targets: Element[] }[] = [];
let frames: FrameRequestCallback[] = [];
const flushFrames = () => { const run = frames; frames = []; for (const f of run) f(0); };

let host: HTMLDivElement;
let root: Root;
let el: HTMLElement;
let top = 0;
let restoreRect = () => {};

const heightOf = (scroller: Element) => scroller.querySelectorAll('[data-row]').length * ROW;
const scrollHeight = () => heightOf(el);
const distance = () => scrollHeight() - top - VIEW;
const userScrollTo = (next: number) => { top = next; act(() => { el.dispatchEvent(new Event('scroll')); }); };
/** What the inner ResizeObserver reports after a commit changed the content. */
const fireInnerResize = () => act(() => {
    const inner = el.querySelector('.cl-inner')!;
    for (const o of observers) {
        if (o.targets.includes(inner)) o.cb([{ contentRect: { height: scrollHeight() } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    }
});

beforeEach(() => {
    observers.length = 0;
    frames = [];
    vi.stubGlobal('ResizeObserver', class {
        private entry: { cb: ResizeObserverCallback; targets: Element[] };
        constructor(cb: ResizeObserverCallback) { this.entry = { cb, targets: [] }; observers.push(this.entry); }
        observe(target: Element) { this.entry.targets.push(target); }
        unobserve() {}
        disconnect() { this.entry.targets = []; }
    });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    store.set({ messages: messages(100, 109), isLoaded: true, hasMoreOlder: true, isLoadingOlder: false });
    // Geometry for every `.cl-scroll` the list renders (installed before mount,
    // so the mount-time reset lands at the real bottom).
    top = 0;
    const max = (scroller: Element) => Math.max(0, heightOf(scroller) - VIEW);
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.classList.contains('cl-scroll') ? heightOf(this) : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList.contains('cl-scroll') ? VIEW : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
        configurable: true,
        get() { return this.classList.contains('cl-scroll') ? top : 0; },
        set(v: number) { if (this.classList.contains('cl-scroll')) top = Math.min(Math.max(0, v), max(this)); },
    });
    const rect = HTMLElement.prototype.getBoundingClientRect;
    restoreRect = () => { HTMLElement.prototype.getBoundingClientRect = rect; };
    // Layout: the scroller's viewport starts at y=0, `.cl-inner` is shifted up
    // by scrollTop, every row is ROW tall in document order.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        const box = rect.call(this);
        if (this.classList.contains('cl-inner')) return { ...box.toJSON(), top: -top, bottom: heightOf(this.parentElement!) - top, height: heightOf(this.parentElement!) } as DOMRect;
        if (this.hasAttribute('data-row')) {
            const index = [...this.parentElement!.children].filter((c) => c.hasAttribute('data-row')).indexOf(this);
            return { ...box.toJSON(), top: index * ROW - top, bottom: (index + 1) * ROW - top, height: ROW } as DOMRect;
        }
        return box;
    };
    HTMLElement.prototype.scrollTo = function (this: HTMLElement, opts?: ScrollToOptions | number) {
        if (this.classList.contains('cl-scroll') && typeof opts === 'object') top = Math.min(Math.max(0, opts.top ?? top), max(this));
    } as HTMLElement['scrollTo'];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<ChatList sessionId="s" />));
    el = host.querySelector('.cl-scroll') as HTMLElement;
    fireInnerResize();
    flushFrames();
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    restoreRect();
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
});

/** One background-prefetch page, committed like sync.loadOlderMessages. */
function prependOlderPage(fromSeq: number, toSeq: number) {
    act(() => store.set({ isLoadingOlder: true }));
    act(() => store.set({ messages: [...store.get().messages, ...messages(fromSeq, toSeq)] }));
    fireInnerResize();
    act(() => store.set({ isLoadingOlder: false }));
    flushFrames();
}

describe('older history landing at the top never pulls the reader down', () => {
    it('lands at the bottom on open (baseline)', () => {
        expect(distance()).toBe(0);
    });

    it('keeps a reader 40px up (inside the 80px follow band) where they are across prefetch pages', () => {
        userScrollTo(top - 40);
        expect(distance()).toBe(40);
        prependOlderPage(90, 99);
        expect(distance()).toBe(40);
        // the reader keeps scrolling up slowly — progress accumulates and leaves the band
        userScrollTo(top - 30);
        prependOlderPage(80, 89);
        expect(distance()).toBe(70);
        userScrollTo(top - 30);
        prependOlderPage(70, 79);
        expect(distance()).toBe(100);
    });

    it('also when the page and the end of loading commit together', () => {
        userScrollTo(top - 40);
        act(() => store.set({ isLoadingOlder: true }));
        act(() => store.set({ messages: [...store.get().messages, ...messages(90, 99)], isLoadingOlder: false }));
        fireInnerResize();
        flushFrames();
        expect(distance()).toBe(40);
    });

    it('keeps a reader far up where they are (pre-existing rule)', () => {
        userScrollTo(top - 500);
        prependOlderPage(90, 99);
        expect(distance()).toBe(500);
    });

    it('a reader at the very bottom stays at the bottom', () => {
        prependOlderPage(90, 99);
        expect(distance()).toBe(0);
    });
});

describe('new content at the bottom still follows', () => {
    it('a new newest message pulls an in-band reader to the bottom', () => {
        userScrollTo(top - 40);
        act(() => store.set({ messages: [...messages(110, 110), ...store.get().messages] }));
        expect(distance()).toBe(0);
    });

    it('a growth decision is dropped if the reader scrolled away before the frame ran', () => {
        // content grows in place (a tool output expanding) while at the bottom → follow is scheduled …
        const grown = document.createElement('div');
        grown.setAttribute('data-row', '');
        el.querySelector('.cl-inner')!.appendChild(grown);
        fireInnerResize();
        // … but the reader scrolls up past the band before the next frame
        userScrollTo(top - 400);
        const readingAt = distance();
        expect(readingAt).toBeGreaterThan(80);
        flushFrames();
        expect(distance()).toBe(readingAt);
    });
});

/**
 * B-598 regression (Xu CHEN 2026-10-13, desktop): after sending, scrolling up
 * to re-read the start of the reply while it streams got yanked back to the
 * bottom. onScroll re-armed `atBottom` whenever the reader was inside the 80px
 * band, and every streamed token (row effect / growth follower) then scrolled
 * to the bottom — a trackpad moving a few px per event never left the band.
 * An upward scroll gesture now detaches at once; only reaching the real
 * bottom (or send / jump / session switch) re-attaches.
 */
describe('an upward gesture during streaming detaches from the live end', () => {
    /** The newest (agent) message grows in place, like a streamed token. */
    const streamToken = () => act(() => {
        const [newest, ...rest] = store.get().messages as Msg[];
        store.set({ messages: [{ ...newest, text: `${newest.text} tok` }, ...rest] });
    });
    /** A trackpad / slow wheel step: the wheel event, then the scroll it causes. */
    const wheel = (deltaY: number) => {
        act(() => { el.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true })); });
        userScrollTo(top + deltaY);
    };
    const touch = (type: 'touchstart' | 'touchmove', clientY: number) => act(() => {
        const ev = new Event(type, { bubbles: true });
        Object.defineProperty(ev, 'touches', { value: [{ clientY }] });
        el.dispatchEvent(ev);
    });
    const key = (init: KeyboardEventInit, target: Element = el) => act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    });

    it('a 10px wheel-up between streamed tokens is not snapped back, and keeps accumulating', () => {
        streamToken();
        expect(distance()).toBe(0);
        wheel(-10);
        streamToken();
        expect(distance()).toBe(10);
        flushFrames();
        expect(distance()).toBe(10);
        wheel(-10);
        streamToken();
        expect(distance()).toBe(20);
        expect(host.querySelector('.cl-jump')).not.toBeNull();
    });

    it('a growth follow scheduled before the gesture is dropped', () => {
        const grown = document.createElement('div');
        grown.setAttribute('data-row', '');
        el.querySelector('.cl-inner')!.appendChild(grown);
        fireInnerResize(); // decision taken while attached …
        wheel(-10); // … reader scrolls up before the frame
        const readingAt = distance();
        expect(readingAt).toBeGreaterThan(0);
        flushFrames();
        expect(distance()).toBe(readingAt);
    });

    it('a touch drag that scrolls the content up detaches too', () => {
        touch('touchstart', 200);
        touch('touchmove', 210); // finger moves down → content scrolls up
        userScrollTo(top - 10);
        streamToken();
        expect(distance()).toBe(10);
    });

    it('PageUp on the transcript detaches; the same key typed in the composer does not', () => {
        const composer = document.createElement('textarea');
        document.body.appendChild(composer);
        key({ key: 'PageUp' }, composer);
        streamToken();
        expect(host.querySelector('.cl-jump')).toBeNull();
        composer.remove();
        key({ key: 'PageUp' });
        userScrollTo(top - 10);
        streamToken();
        expect(distance()).toBe(10);
    });

    it('reaching the real bottom re-arms following', () => {
        wheel(-10);
        streamToken();
        expect(distance()).toBe(10);
        wheel(10); // back to the bottom (distance 0)
        expect(distance()).toBe(0);
        expect(host.querySelector('.cl-jump')).toBeNull();
        act(() => store.set({ messages: [...messages(110, 110), ...store.get().messages] }));
        expect(distance()).toBe(0);
    });

    it('inside the band while detached does not re-arm (only the real bottom does)', () => {
        wheel(-40);
        wheel(30); // 10px from the bottom, still detached
        streamToken();
        expect(distance()).toBe(10);
    });

    it('sending again re-attaches even from far up', () => {
        wheel(-500);
        act(() => store.set({ messages: [
            { kind: 'user-text', id: 'own', text: 'again', createdAt: 200, seq: 200, localId: 'l-own', sendState: 'sending' },
            ...store.get().messages,
        ] }));
        expect(distance()).toBe(0);
        streamToken();
        expect(distance()).toBe(0);
    });

    it('a downward wheel at the bottom does not detach', () => {
        act(() => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, bubbles: true })); });
        streamToken();
        expect(host.querySelector('.cl-jump')).toBeNull();
    });
});

/**
 * B-603 regression (Xu CHEN 2026-10-15, iPhone Safari tab, idle 13k-message
 * session): reading back while the background prefetch landed a page every
 * ~0.5 s, the view kept leaping to much older content, and 「跳到最新」 /
 * 「上一条提问」 stopped far from where they aim. Each page was compensated with
 * `scrollTop += height`, but WebKit ignores scrollTop writes while a scroll is
 * in progress (iOS momentum, a smooth scrollTo animation — the animation keeps
 * going to its old target), so the compensation was lost. Pages now wait while
 * the transcript moves and land, compensated, once it settles.
 */
describe('older history waits while the transcript is moving', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });
    const rowsInDom = () => el.querySelectorAll('[data-row]').length;
    const touch = (type: 'touchstart' | 'touchend', touches: number) => act(() => {
        const ev = new Event(type, { bubbles: true });
        Object.defineProperty(ev, 'touches', { value: Array.from({ length: touches }, () => ({ clientY: 100 })) });
        el.dispatchEvent(ev);
    });
    /** A WebKit-style scroll in progress: compensation writes are overridden by the next animation step. */
    const animationStep = (to: number) => userScrollTo(to);

    it('a page landing mid-scroll is not rendered until the scroll settles, then lands without moving the reader', () => {
        userScrollTo(top - 500); // reader scrolls up (motion starts)
        const before = rowsInDom();
        const readingAt = distance();
        prependOlderPage(90, 99);
        expect(rowsInDom()).toBe(before); // held: nothing changed above the reader
        animationStep(top - 20); // the scroll keeps moving: WebKit would have discarded a compensation here
        expect(distance()).toBe(readingAt + 20);
        act(() => { vi.advanceTimersByTime(SCROLL_SETTLE_MS + 50); });
        expect(rowsInDom()).toBe(before + 10); // released once settled …
        expect(distance()).toBe(readingAt + 20); // … and the reader's content did not move
    });

    it('keeps the content under the reader in place across release (anchor, not scrollTop)', () => {
        userScrollTo(top - 500);
        const anchorTop = () => {
            const rows = [...el.querySelector('.cl-inner')!.children].filter((c) => c.hasAttribute('data-row'));
            const i = Math.floor(top / ROW);
            return { node: rows[i], y: rows[i].getBoundingClientRect().top };
        };
        const a = anchorTop();
        prependOlderPage(90, 99);
        act(() => { vi.advanceTimersByTime(SCROLL_SETTLE_MS + 50); });
        expect(a.node.isConnected).toBe(true);
        expect(a.node.getBoundingClientRect().top).toBe(a.y);
    });

    it('a finger still down keeps holding however long it rests', () => {
        touch('touchstart', 1);
        const before = rowsInDom();
        prependOlderPage(90, 99);
        act(() => { vi.advanceTimersByTime(SCROLL_SETTLE_MS * 10); });
        expect(rowsInDom()).toBe(before);
        touch('touchend', 0);
        act(() => { vi.advanceTimersByTime(SCROLL_SETTLE_MS + 50); });
        expect(rowsInDom()).toBe(before + 10);
        expect(distance()).toBe(0); // was at the bottom, still is
    });

    it('a smooth 「跳到最新」 in progress is not cut short by a page landing', () => {
        userScrollTo(top - 250); // within 2 viewports → smooth jump
        act(() => { vi.advanceTimersByTime(SCROLL_SETTLE_MS + 50); });
        const target = scrollHeight() - VIEW; // where the animation is heading
        animationStep(top + 100); // animation frame
        prependOlderPage(90, 99); // page lands mid-animation
        animationStep(target); // the engine finishes at its original target
        act(() => { vi.advanceTimersByTime(SCROLL_SETTLE_MS + 50); });
        expect(distance()).toBe(0);
    });

    it('our own instant scroll (bottom follow) is not motion: pages still land right away', () => {
        const before = rowsInDom();
        act(() => store.set({ messages: [...messages(110, 110), ...store.get().messages] })); // follow → scrollTo bottom
        act(() => { el.dispatchEvent(new Event('scroll')); }); // the event for our own write
        prependOlderPage(90, 99);
        expect(rowsInDom()).toBe(before + 1 + 10);
        expect(distance()).toBe(0);
    });
});
