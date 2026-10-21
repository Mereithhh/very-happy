// @vitest-environment happy-dom
/**
 * B-678: opening or refreshing /machine/<id> renders once before the machine is
 * in storage and again after it arrives. A hook below the `if (!machine)`
 * early return changed the hook count between those renders and React threw
 * #310 ("Rendered more hooks than during the previous render"). Navigating from
 * Settings never hit it because the machine was already loaded.
 */
import { act, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const machineStore = vi.hoisted(() => {
  let machine: unknown = null;
  const listeners = new Set<() => void>();
  return {
    get: () => machine,
    set: (next: unknown) => { machine = next; listeners.forEach((l) => l()); },
    subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); },
  };
});

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/sync/storage', () => ({
  storage: { getState: () => ({}) },
  useMachine: () => useSyncExternalStore(machineStore.subscribe, machineStore.get),
  useAllSessions: () => [],
  useSetting: () => undefined,
  useLocalSetting: () => false,
}));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('@/sync/ops', () => ({}));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/ui', () => {
  const Box = ({ children, title, actions }: { children?: ReactNode; title?: ReactNode; actions?: ReactNode }) => (
    <div>{title}{children}{actions}</div>
  );
  return {
    EmptyState: ({ title }: { title: string }) => <div data-empty>{title}</div>,
    Button: Box, Input: () => <input />, ItemList: Box, ItemGroup: Box, Badge: Box,
    Item: ({ title }: { title?: ReactNode }) => <div>{title}</div>,
    StatusDot: () => null, Spinner: () => null,
    useToast: () => ({ success: () => {}, error: () => {} }),
  };
});
vi.mock('@/screens/settings/SettingsLayout', () => ({
  SettingsPage: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SettingsHeader: ({ title }: { title?: ReactNode }) => <h1 data-title>{title}</h1>,
}));
vi.mock('@/screens/sessions/ImportHistoryModal', () => ({ ImportHistoryModal: () => null }));
vi.mock('./AgentVersionsGroup', () => ({ AgentVersionsGroup: () => null }));
vi.mock('./rateLimits/MachineRateLimits', () => ({ MachineRateLimits: () => null }));
vi.mock('./MachineHibernationGroup', () => ({ MachineHibernationGroup: () => null }));

let MachineScreen: typeof import('./MachineScreen').MachineScreen;
beforeAll(async () => {
  ({ MachineScreen } = await import('./MachineScreen'));
});

let host: HTMLDivElement;
let root: Root;
const uncaught = vi.fn();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  machineStore.set(null);
  uncaught.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host, { onUncaughtError: uncaught });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it('a cold load renders the placeholder, then the machine once it arrives, without a hook-order crash', async () => {
  await act(async () => root.render(
    <MemoryRouter initialEntries={['/machine/m1']}>
      <Routes><Route path="/machine/:id" element={<MachineScreen />} /></Routes>
    </MemoryRouter>,
  ));
  expect(host.querySelector('[data-empty]')).not.toBeNull();

  await act(async () => machineStore.set({
    id: 'm1', active: true, activeAt: Date.now(), createdAt: 0, updatedAt: 0, seq: 0,
    metadata: { host: 'dev-box', displayName: 'Dev Box', homeDir: '/home/me', platform: 'linux' },
    daemonState: { status: 'running', pid: 1 },
  }));

  expect(uncaught).not.toHaveBeenCalled();
  expect(host.querySelector('[data-empty]')).toBeNull();
  expect(host.textContent).toContain('Dev Box');
});
