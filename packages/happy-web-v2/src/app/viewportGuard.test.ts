// @vitest-environment happy-dom
// B-855: iPad (Xu CHEN 11-01) — the whole app sat ~300px up with a blank band
// below: iOS left the locked document scrolled. installViewportVars must undo
// that after any of these events, recognise an iPad with a trackpad
// (pointer: fine) as a touch screen, and leave iOS's pan alone while the
// keyboard is up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const H = 834;
let scrollY = 0;
let frames: FrameRequestCallback[] = [];
let vv: EventTarget & { height: number; offsetTop: number; scale: number };
const scrollTo = vi.fn(() => { scrollY = 0; });

function flush() {
    const run = frames;
    frames = [];
    run.forEach((cb) => cb(0));
}

async function install(maxTouchPoints: number) {
    vi.resetModules();
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => maxTouchPoints });
    const mod = await import('./viewportVars');
    mod.installViewportVars();
    flush();
    return mod;
}

beforeEach(() => {
    scrollY = 0;
    frames = [];
    scrollTo.mockClear();
    vv = Object.assign(new EventTarget(), { height: H, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => H });
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    Object.defineProperty(window, 'scrollX', { configurable: true, get: () => 0 });
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    window.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
    // iPad + Magic Keyboard: pointer is fine, there is no coarse primary pointer.
    window.matchMedia = ((q: string) => ({ matches: q === '(pointer: fine)', media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
    document.documentElement.dataset.rootLock = 'true';
});

afterEach(() => {
    delete document.documentElement.dataset.rootLock;
    delete document.documentElement.dataset.keyboardOpen;
});

const TRIGGERS: Array<[string, () => void]> = [
    ['window scroll', () => window.dispatchEvent(new Event('scroll'))],
    ['orientationchange', () => window.dispatchEvent(new Event('orientationchange'))],
    ['window resize', () => window.dispatchEvent(new Event('resize'))],
    ['pageshow', () => window.dispatchEvent(new Event('pageshow'))],
    ['focusout', () => window.dispatchEvent(new Event('focusout'))],
    ['visibilitychange', () => document.dispatchEvent(new Event('visibilitychange'))],
    ['visualViewport resize', () => vv.dispatchEvent(new Event('resize'))],
    ['visualViewport scroll', () => vv.dispatchEvent(new Event('scroll'))],
];

describe('installViewportVars root-scroll guard (B-855)', () => {
    it.each(TRIGGERS)('a locked document scrolled by iOS is reset after %s', async (_name, fire) => {
        // (window listeners from earlier tests' installs persist; any of them may do the reset)
        await install(5);
        scrollY = 311;
        fire();
        flush();
        expect(scrollTo).toHaveBeenCalledWith(0, 0);
        expect(scrollY).toBe(0);
    });

    it('iPad with a trackpad (pointer: fine, 5 touch points): the keyboard is recognised and its pan is not fought', async () => {
        const mod = await install(5);
        vv.height = 436;
        scrollY = 300; // iOS reveal-pan
        vv.dispatchEvent(new Event('resize'));
        flush();
        expect(mod.getKeyboardViewport().open).toBe(true);
        expect(document.documentElement.dataset.keyboardOpen).toBe('true');
        expect(scrollTo).not.toHaveBeenCalled();

        vv.height = H; // keyboard down, the pan residue stays
        vv.dispatchEvent(new Event('resize'));
        flush();
        expect(mod.getKeyboardViewport().open).toBe(false);
        expect(scrollY).toBe(0);
        expect(mod.getRootScrollResets()).toBe(1);
    });

    it('public pages (no root lock) keep their scroll', async () => {
        await install(5);
        delete document.documentElement.dataset.rootLock;
        scrollY = 311;
        window.dispatchEvent(new Event('scroll'));
        flush();
        expect(scrollTo).not.toHaveBeenCalled();
    });

    it('a desktop without a touch screen never enters the keyboard path', async () => {
        const mod = await install(0);
        vv.height = 436;
        vv.dispatchEvent(new Event('resize'));
        flush();
        expect(mod.getKeyboardViewport().open).toBe(false);
    });
});
