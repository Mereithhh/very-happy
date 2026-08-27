import { describe, expect, it, vi } from 'vitest';
import { dismissPrepaintSplash, dismissPrepaintSplashWhenRouteReady } from './prepaintSplash';

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

describe('dismissPrepaintSplashWhenRouteReady', () => {
  it('keeps the pre-paint loader as the only animated layer until route loading ends', () => {
    let routeLoading = true;
    const root = { querySelector: vi.fn(() => (routeLoading ? {} : null)) };
    const dismiss = vi.fn(() => true);
    const disconnect = vi.fn();
    const observe = vi.fn();
    let notifyMutation: MutationCallback | undefined;
    const createObserver = vi.fn((callback: MutationCallback) => {
      notifyMutation = callback;
      return { observe, disconnect };
    });

    const cleanup = dismissPrepaintSplashWhenRouteReady(root as unknown as Element, createObserver, dismiss);

    expect(dismiss).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith(root, { childList: true, subtree: true });

    routeLoading = false;
    notifyMutation?.([], {} as MutationObserver);

    expect(dismiss).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();

    cleanup();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('dismisses immediately when the first route is already ready', () => {
    const dismiss = vi.fn(() => true);
    const createObserver = vi.fn();

    dismissPrepaintSplashWhenRouteReady(
      { querySelector: vi.fn(() => null) } as unknown as Element,
      createObserver,
      dismiss,
    );

    expect(dismiss).toHaveBeenCalledOnce();
    expect(createObserver).not.toHaveBeenCalled();
  });
});
