// @vitest-environment happy-dom
/**
 * B-504: `useAutomationsPoll` state machine on a real React mount — the
 * sidebar entry must not depend on one first request succeeding.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: null as { credentials: { token: string; secret: string } } | null,
  resumeListeners: new Set<() => void>(),
}));
vi.mock('@/auth/AuthContext', () => ({ getCurrentAuth: () => mocks.auth }));
vi.mock('@/sync/sync', () => ({
  sync: {
    onResume: (listener: () => void) => {
      mocks.resumeListeners.add(listener);
      return () => mocks.resumeListeners.delete(listener);
    },
  },
}));
vi.mock('@/sync/apiAutomations', () => ({
  AutomationsApiError: class extends Error {},
  isAutomationsDisabled: () => false,
}));

import { useAutomations, useAutomationsPoll } from './automationsStore';
import { AUTOMATIONS_AUTH_RETRY_MS, AUTOMATIONS_DISABLED_RECHECK_MS } from './automationsPoll';

const SIDEBAR_MS = 60_000;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let refresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
let hidden = false;

function Poller({ active = true }: { active?: boolean }) {
  useAutomationsPoll(refresh, SIDEBAR_MS, active);
  return null;
}
const mount = () => act(async () => root.render(<Poller />));
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  hidden = false;
  mocks.auth = { credentials: { token: 'tok', secret: 'sec' } };
  mocks.resumeListeners.clear();
  refresh = vi.fn(async () => {});
  useAutomations.setState({ enabled: null, automations: [], attention: [], error: null, loadedAt: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('useAutomationsPoll (B-504)', () => {
  it('polls at once when the credentials are already published', async () => {
    await mount();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not spend the first attempt on a missing token: it waits and retries within a second', async () => {
    mocks.auth = null;
    await mount();
    expect(refresh).not.toHaveBeenCalled();
    await advance(AUTOMATIONS_AUTH_RETRY_MS);
    expect(refresh).not.toHaveBeenCalled(); // still no credentials → keep waiting
    mocks.auth = { credentials: { token: 'tok', secret: 'sec' } };
    await advance(AUTOMATIONS_AUTH_RETRY_MS);
    expect(refresh).toHaveBeenCalledTimes(1); // far sooner than the 60 s sidebar tick
  });

  it('keeps ticking on the caller cadence while visible and skips hidden ticks', async () => {
    await mount();
    await advance(SIDEBAR_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    hidden = true;
    await advance(SIDEBAR_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    for (const listener of mocks.resumeListeners) listener();
    expect(refresh).toHaveBeenCalledTimes(3); // resume always refreshes
  });

  it('a disabled answer slows polling to the recheck interval instead of stopping for good', async () => {
    await mount();
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { useAutomations.setState({ enabled: false }); });
    // the cadence change re-ran the effect, but it must not re-ask right after the 404
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(SIDEBAR_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(AUTOMATIONS_DISABLED_RECHECK_MS - SIDEBAR_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(2); // the entry can come back once the server re-enables it
    await act(async () => { useAutomations.setState({ enabled: true }); });
    await advance(SIDEBAR_MS);
    expect(refresh).toHaveBeenCalledTimes(4); // back on the fast cadence (mount tick + interval)
  });

  it('does nothing while inactive', async () => {
    await act(async () => root.render(<Poller active={false} />));
    await advance(SIDEBAR_MS * 2);
    expect(refresh).not.toHaveBeenCalled();
  });
});
