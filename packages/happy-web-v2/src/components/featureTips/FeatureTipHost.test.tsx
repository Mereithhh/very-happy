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
