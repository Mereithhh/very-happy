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
import 'fake-indexeddb/auto';
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
const { clearNotificationStateOnLogout } = vi.hoisted(() => ({ clearNotificationStateOnLogout: vi.fn() }));
vi.mock('@/screens/notifications/logoutCleanup', () => ({ clearNotificationStateOnLogout }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { setCredentials: vi.fn(), removeCredentials: vi.fn() } }));

import { AuthProvider, getCurrentAuth, setCurrentAuth } from './AuthContext';
import { CACHE_DB_PREFIX, syncCache } from '@/sync/cache/syncCache';

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

it('B-559: logout clears the notification badge / SW count / mark-unread overlay', async () => {
  await act(async () => root.render(<AuthProvider initialCredentials={{ token: 'tok', secret: 'sec' }}><span /></AuthProvider>));
  const reload = vi.fn();
  const loc = window.location;
  Object.defineProperty(window, 'location', { configurable: true, value: { ...loc, reload } });
  try {
    await act(async () => { await getCurrentAuth()!.logout(); });
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: loc });
  }
  expect(clearNotificationStateOnLogout).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalled();
});

it('B-813: logout deletes every local message cache database (Owner 10-25: 退出登录时全部清空)', async () => {
  // This tab's cache is open and holds a session's ciphertext rows.
  await syncCache.open('account-a');
  syncCache.offerLatest('s1', [{ id: 'm1', seq: 1, localId: null, content: { t: 'encrypted', c: 'Y2lwaGVy' }, createdAt: 1, updatedAt: 1 }], { viewed: true });
  await syncCache.flush();
  expect((await syncCache.load('s1'))?.lastSeq).toBe(1);
  // Another account signed in earlier on this browser left one too.
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(`${CACHE_DB_PREFIX}otheraccount0000`, 1);
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
  const names = async () => (await indexedDB.databases()).map((db) => db.name).filter((name) => name?.startsWith(CACHE_DB_PREFIX));
  expect(await names()).toHaveLength(2);

  await act(async () => root.render(<AuthProvider initialCredentials={{ token: 'tok', secret: 'sec' }}><span /></AuthProvider>));
  const loc = window.location;
  Object.defineProperty(window, 'location', { configurable: true, value: { ...loc, reload: vi.fn() } });
  try {
    await act(async () => { await getCurrentAuth()!.logout(); });
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: loc });
  }
  expect(await names()).toEqual([]);
});
