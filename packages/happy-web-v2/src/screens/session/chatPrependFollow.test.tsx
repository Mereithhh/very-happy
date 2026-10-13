// @vitest-environment happy-dom
/**
 * Regression (Owner 2026-10-13, veryhappy.dev eccf6b55): scrolling up an idle
 * chat snapped back to the bottom. Cause: after a session opens,
 * sync.prefetchOlderMessagesInBackground prepends a page of OLDER history at
 * the top every ~250 ms. Each page bumps rows.length and grows `.cl-inner`;
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
vi.mock('@/sync/ops', () => ({ sessionCancelQueuedMessage: vi.fn() }));
vi.mock('@/sync/liveStreamStore', () => ({ endLiveStreamTurn: vi.fn() }));
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
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        const box = rect.call(this);
        return this.classList.contains('cl-inner') ? { ...box.toJSON(), height: heightOf(this) } as DOMRect : box;
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
