// @vitest-environment happy-dom
/** QA17 P2-3: on desktop the toast stack (bottom centre) must not cover a
 *  centred notice card's buttons (更新日志「下一条」). */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, toast, toastHeldByCard } from './Toast';

const box = (top: number, bottom: number, left = 400, right = 1000) => ({ top, bottom, left, right, height: bottom - top, width: right - left, x: left, y: top, toJSON() {} }) as DOMRect;

describe('toastHeldByCard', () => {
  const stack = { top: 830, bottom: 880, left: 560, right: 880 };
  it('holds only while the stack overlaps the card', () => {
    expect(toastHeldByCard({ top: 200, bottom: 700, left: 460, right: 980 }, stack)).toBe(false);
    expect(toastHeldByCard({ top: 300, bottom: 860, left: 0, right: 500 }, stack)).toBe(false); // beside it
    expect(toastHeldByCard({ top: 20, bottom: 880, left: 460, right: 980 }, stack)).toBe(true);
    expect(toastHeldByCard({ top: 40, bottom: 831, left: 460, right: 980 }, stack)).toBe(true);
  });
});

describe('toast stack vs a notice card (desktop)', () => {
  let root: Root | null = null;
  let cardRect = box(20, 880);
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('vh-toasts')) return box(830, 880, 560, 880);
      if (this.hasAttribute('data-toast-avoid')) return cardRect;
      return box(0, 0);
    });
  });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const region = () => document.querySelector<HTMLElement>('.vh-toasts')!;
  const mount = async () => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<ToastProvider><span /></ToastProvider>));
  };
  // The provider re-measures on DOM mutations (MutationObserver) and on resize; happy-dom's
  // observer delivery does not follow fake timers, so the test nudges it with a resize.
  const closeCard = async (card: HTMLElement) => {
    card.remove();
    await act(async () => { window.dispatchEvent(new Event('resize')); await vi.advanceTimersByTimeAsync(0); });
  };
  const openCard = () => { const card = document.createElement('div'); card.setAttribute('data-toast-avoid', ''); document.body.append(card); return card; };

  it('a card the stack does not reach changes nothing', async () => {
    cardRect = box(150, 750);
    await mount();
    openCard();
    await act(async () => toast.show('Started a session for X', 'success', { durationMs: 8_000 }));
    expect(region().classList.contains('vh-toasts--held')).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    expect(document.querySelector('.vh-toast')).toBeNull();
  });

  it('an overlapped card holds the toast (hidden, timer paused) until it closes, then gives it its full time', async () => {
    cardRect = box(20, 880);
    await mount();
    const card = openCard();
    await act(async () => toast.show('Started a session for X', 'success', { durationMs: 8_000 }));
    expect(region().classList.contains('vh-toasts--held')).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(document.querySelector('.vh-toast')).not.toBeNull(); // not expired while unseen
    await act(async () => toast.show('Started a session for Y', 'success', { durationMs: 8_000 })); // arrives while held
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(document.querySelectorAll('.vh-toast')).toHaveLength(2);
    await closeCard(card);
    expect(region().classList.contains('vh-toasts--held')).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(7_900); });
    expect(document.querySelector('.vh-toast')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(document.querySelector('.vh-toast')).toBeNull();
  });
});
