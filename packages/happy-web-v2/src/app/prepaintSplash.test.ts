import { describe, expect, it, vi } from 'vitest';
import { dismissPrepaintSplash } from './prepaintSplash';

describe('dismissPrepaintSplash', () => {
  it('performs one fade handoff and removes the splash after the transition', () => {
    const remove = vi.fn();
    const splash = { dataset: {} as DOMStringMap, style: { opacity: '' }, remove };
    const doc = { getElementById: vi.fn(() => splash) };
    const schedule = vi.fn<(callback: () => void, delay: number) => unknown>();

    expect(dismissPrepaintSplash(doc as never, schedule, '')).toBe(true);
    expect(splash.dataset.dismissing).toBe('true');
    expect(splash.style.opacity).toBe('0');
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 340);
    expect(dismissPrepaintSplash(doc as never, schedule, '')).toBe(false);
    expect(schedule).toHaveBeenCalledTimes(1);

    schedule.mock.calls[0]![0]();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('keeps the pre-paint loader mounted in preview mode', () => {
    const getElementById = vi.fn();
    expect(
      dismissPrepaintSplash({ getElementById } as never, vi.fn(), '?vh-loader-preview=1'),
    ).toBe(false);
    expect(getElementById).not.toHaveBeenCalled();
  });
});
