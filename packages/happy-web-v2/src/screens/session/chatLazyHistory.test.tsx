// @vitest-environment happy-dom
/**
 * B-616 (Xu CHEN 2026-10-16 recording, iPhone Safari, a ~13k-message session):
 * the view kept jumping to much earlier content in the first minute after
 * opening. The background prefetch inserted a page above the reader every
 * ~0.5s for ~134 pages; iOS WebKit drops the compensating scrollTop write
 * while a momentum scroll runs (B-603's hold narrowed it, did not close it).
 *
 * Now older history is fetched only when the reader PARKS the top of the
 * loaded history within a screen and the scroll has settled. Mounts the REAL
 * ChatList on a fake store with scroll geometry stubbed (100px per row,
 * 300px viewport) and a controllable clock, and counts sync.loadOlderMessages.
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
vi.mock('@/sync/sync', () => ({ sync: { loadOlderMessages: vi.fn(async () => {}) } }));
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
import { sync } from '@/sync/sync';
import { LOAD_OLDER_NEAR_TOP_MIN_PX, SCROLL_SETTLE_MS, shouldRequestOlder } from './chatFollow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('shouldRequestOlder (pure)', () => {
    const base = { scrollTop: 0, clientHeight: 300, hasMoreOlder: true, isLoadingOlder: false, settled: true };
    it('asks when parked within a screen of the top', () => {
        expect(shouldRequestOlder(base)).toBe(true);
        expect(shouldRequestOlder({ ...base, scrollTop: LOAD_OLDER_NEAR_TOP_MIN_PX })).toBe(true);
        expect(shouldRequestOlder({ ...base, scrollTop: 700, clientHeight: 800 })).toBe(true);
    });
    it('not further down, not while moving, not while loading, not without older history', () => {
        expect(shouldRequestOlder({ ...base, scrollTop: LOAD_OLDER_NEAR_TOP_MIN_PX + 1 })).toBe(false);
        expect(shouldRequestOlder({ ...base, settled: false })).toBe(false);
        expect(shouldRequestOlder({ ...base, isLoadingOlder: true })).toBe(false);
        expect(shouldRequestOlder({ ...base, hasMoreOlder: false })).toBe(false);
    });
});

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

let host: HTMLDivElement;
let root: Root;
let el: HTMLElement;
let top = 0;
let now = 0;
let restoreRect = () => {};

const heightOf = (scroller: Element) => scroller.querySelectorAll('[data-row]').length * ROW;
const requests = () => vi.mocked(sync.loadOlderMessages).mock.calls.length;
/** A scroll event the code did not write itself (finger / wheel / momentum). */
const userScrollTo = (next: number) => { top = next; act(() => { el.dispatchEvent(new Event('scroll')); }); };
const advance = (ms: number) => act(() => { now += ms; vi.advanceTimersByTime(ms); });
const touch = (type: 'touchstart' | 'touchend', clientY = 100) => act(() => {
    const ev = new Event(type, { bubbles: true });
    Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : [{ clientY }] });
    el.dispatchEvent(ev);
});
/** One page landing, committed like sync.loadOlderMessages. */
const landPage = (fromSeq: number, toSeq: number) => {
    act(() => store.set({ isLoadingOlder: true }));
    act(() => store.set({ messages: [...store.get().messages, ...messages(fromSeq, toSeq)] }));
    act(() => store.set({ isLoadingOlder: false }));
};

function mount(rows: Msg[], patch: Partial<ReturnType<typeof store.get>> = {}) {
    store.set({ messages: rows, isLoaded: true, hasMoreOlder: true, isLoadingOlder: false, ...patch });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<ChatList sessionId="s" />));
    el = host.querySelector('.cl-scroll') as HTMLElement;
}

describe('older history is requested only by a parked reader (B-616)', () => {
let nowSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    vi.useFakeTimers();
    now = 10_000; // the page has been up a while: nothing is "moving" at mount
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.mocked(sync.loadOlderMessages).mockClear();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
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
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    nowSpy.mockRestore();
    restoreRect();
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
});

    it('a reader at the bottom of a long transcript never triggers a fetch, however long they stay', () => {
        mount(messages(100, 119)); // 20 rows = 2000px, viewport 300 → scrollTop 1700
        expect(top).toBe(1700);
        advance(60_000);
        expect(requests()).toBe(0);
    });

    it('scrolling to the top asks for one page once the scroll has settled — not while it is still moving', () => {
        mount(messages(100, 119));
        userScrollTo(0);
        expect(requests()).toBe(0);
        advance(SCROLL_SETTLE_MS - 1);
        expect(requests()).toBe(0);
        advance(2);
        expect(requests()).toBe(1);
        // the page lands; the compensation moves the reader down by its height …
        landPage(90, 99);
        expect(top).toBe(1000);
        // … so they are no longer near the top: nothing else is fetched
        advance(5_000);
        expect(requests()).toBe(1);
    });

    it('within a screen of the top counts as parked, not only scrollTop 0', () => {
        mount(messages(100, 119));
        userScrollTo(LOAD_OLDER_NEAR_TOP_MIN_PX);
        advance(SCROLL_SETTLE_MS + 1);
        expect(requests()).toBe(1);
    });

    it('reading further down never fetches, even when settled for a long time', () => {
        mount(messages(100, 119));
        userScrollTo(LOAD_OLDER_NEAR_TOP_MIN_PX + 1);
        advance(10_000);
        expect(requests()).toBe(0);
    });

    it('waits for the finger to lift (iOS: the momentum after it is what breaks the compensation)', () => {
        mount(messages(100, 119));
        touch('touchstart');
        userScrollTo(0);
        advance(2_000);
        expect(requests()).toBe(0);
        touch('touchend');
        advance(SCROLL_SETTLE_MS + 1);
        expect(requests()).toBe(1);
    });

    it('a scroll event that keeps arriving (momentum) keeps postponing the request', () => {
        mount(messages(100, 119));
        userScrollTo(50);
        advance(SCROLL_SETTLE_MS - 20);
        userScrollTo(20);
        advance(SCROLL_SETTLE_MS - 20);
        userScrollTo(0);
        expect(requests()).toBe(0);
        advance(SCROLL_SETTLE_MS + 1);
        expect(requests()).toBe(1);
    });

    it('a window shorter than the viewport keeps filling until the top is a screen away', () => {
        mount(messages(118, 119)); // 2 rows = 200px < 300px viewport
        expect(requests()).toBe(1); // asked right at mount
        landPage(116, 117); // a tiny page: still within a screen of the top
        expect(requests()).toBe(2);
        landPage(100, 115); // 16 more rows → scrollTop compensated far from the top
        expect(top).toBeGreaterThan(LOAD_OLDER_NEAR_TOP_MIN_PX);
        advance(5_000);
        expect(requests()).toBe(2);
    });

    it('no fetch while one is in flight, and none at all once the earliest message is loaded', () => {
        mount(messages(100, 119), { isLoadingOlder: true });
        userScrollTo(0);
        advance(SCROLL_SETTLE_MS + 1);
        expect(requests()).toBe(0);
        act(() => store.set({ isLoadingOlder: false, hasMoreOlder: false }));
        advance(SCROLL_SETTLE_MS + 1);
        expect(requests()).toBe(0);
    });
});
