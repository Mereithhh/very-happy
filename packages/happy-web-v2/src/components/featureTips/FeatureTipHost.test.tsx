// @vitest-environment happy-dom
/** B-588 review: a passive tip must not read as an "open overlay" to the
 *  terminal focus watchdog (termFocusOwnership.OVERLAY_SELECTOR). */
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { hasOpenOverlay } from '@/screens/terminal/termFocusOwnership';
import { FeatureTipHost, resetFeatureTips, useFeatureTipAnchor } from './FeatureTips';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function Anchor() {
  const ref = useRef<HTMLButtonElement | null>(null);
  useFeatureTipAnchor('review-all', ref);
  return <button ref={ref} type="button">Review all</button>;
}

afterEach(() => vi.restoreAllMocks());

it('shows the tip without tripping the terminal overlay detector', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(performance, 'now').mockReturnValue(10_000); // past the startup gate
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.tagName === 'BUTTON' && !this.closest('.vh-tip')
      ? ({ left: 100, top: 100, width: 80, height: 28, right: 180, bottom: 128, x: 100, y: 100, toJSON() {} } as DOMRect)
      : ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect);
  });
  resetFeatureTips();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<><Anchor /><FeatureTipHost /></>));
    await act(async () => { window.dispatchEvent(new Event('resize')); await new Promise((r) => setTimeout(r, 30)); });
    const tip = document.querySelector('.vh-tip');
    expect(tip?.getAttribute('data-tip')).toBe('review-all');
    expect(tip?.getAttribute('role')).not.toBe('dialog');
    expect(hasOpenOverlay(document)).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('B-723 (O4): never covers the session restore banner — waits while it is on screen', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(performance, 'now').mockReturnValue(10_000);
  // Anchor in the header (top-right), the offline banner right under it, full width.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('mrb')) return { left: 0, top: 48, width: 1024, height: 40, right: 1024, bottom: 88, x: 0, y: 48, toJSON() {} } as DOMRect;
    return this.tagName === 'BUTTON' && !this.closest('.vh-tip') && !this.closest('.mrb')
      ? ({ left: 900, top: 10, width: 28, height: 28, right: 928, bottom: 38, x: 900, y: 10, toJSON() {} } as DOMRect)
      : ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} } as DOMRect);
  });
  resetFeatureTips();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const banner = () => <div className="mrb"><button type="button">恢复</button></div>;
  const Banner = banner;
  try {
    await act(async () => root.render(<><Anchor /><Banner /><FeatureTipHost /></>));
    await act(async () => { window.dispatchEvent(new Event('resize')); await new Promise((r) => setTimeout(r, 30)); });
    expect(document.querySelector('.vh-tip')).toBeNull();
    // Banner gone (session restored) → the tip may show.
    await act(async () => root.render(<><Anchor /><FeatureTipHost /></>));
    await act(async () => { window.dispatchEvent(new Event('resize')); await new Promise((r) => setTimeout(r, 30)); });
    expect(document.querySelector('.vh-tip')?.getAttribute('data-tip')).toBe('review-all');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
