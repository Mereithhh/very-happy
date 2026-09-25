// @vitest-environment happy-dom
/**
 * B-504 regression: `getCurrentAuth()` is the credential source for every
 * non-React REST helper (apiAutomations, teams, useTeamNavigation…). React runs
 * a child's passive effects BEFORE its parent's, so a consumer that fetches in
 * `useEffect` on first mount used to see `null` here — the Automations sidebar
 * poll threw a local 401 without ever sending a request, and the entry stayed
 * hidden until the next (visible-only) 60 s tick. The provider must publish
 * the credentials before any descendant effect runs.
 */
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/sync/sync', () => ({ syncCreate: vi.fn() }));
vi.mock('expo-updates', () => ({ reloadAsync: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('@/sync/persistence', () => ({ clearPersistence: vi.fn(), loadRegisteredPushToken: () => null }));
vi.mock('@/sync/apiPush', () => ({ unregisterPushToken: vi.fn() }));
vi.mock('@/track', () => ({ trackLogout: vi.fn() }));
vi.mock('@/app/programmaticReload', () => ({ markProgrammaticReload: vi.fn() }));
vi.mock('@/auth/cloudAuth', () => ({ revokeCloudLogin: vi.fn() }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { setCredentials: vi.fn(), removeCredentials: vi.fn() } }));

import { AuthProvider, getCurrentAuth, setCurrentAuth } from './AuthContext';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setCurrentAuth(null);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setCurrentAuth(null);
});

it('descendant mount effects already see the initial credentials via getCurrentAuth()', async () => {
  const seen: (string | null)[] = [];
  function Probe() {
    useEffect(() => { seen.push(getCurrentAuth()?.credentials?.token ?? null); }, []);
    return null;
  }
  await act(async () => root.render(
    <AuthProvider initialCredentials={{ token: 'tok', secret: 'sec' }}>
      <Probe />
    </AuthProvider>,
  ));
  expect(seen).toEqual(['tok']);
});

it('publishes null when mounted logged out', async () => {
  const seen: unknown[] = [];
  function Probe() {
    useEffect(() => { seen.push(getCurrentAuth()); }, []);
    return null;
  }
  await act(async () => root.render(<AuthProvider initialCredentials={null}><Probe /></AuthProvider>));
  expect(seen).toEqual([null]);
  expect(getCurrentAuth()).toBeNull();
});
