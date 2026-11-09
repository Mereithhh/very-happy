// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ target: null as null | { url: string; name: string }, handoff: vi.fn(), dismissed: {} as Record<string, number>, setDismissed: vi.fn(), assign: vi.fn() }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: { token: 't', secret: 's' } }) }));
vi.mock('@/auth/cloudAuth', () => ({ loadMigrationTarget: async () => mock.target, requestMigrationHandoff: mock.handoff }));
vi.mock('@/sync/storage', () => ({ useLocalSettingMutable: () => [mock.dismissed, mock.setDismissed] }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string, params?: Record<string, string>) => params ? `${key}:${Object.values(params).join(',')}` : key }) }));
vi.mock('./brand', () => ({ BRAND: { name: 'Very Happy' } }));
import { MigrationBanner } from './MigrationBanner';
let host: HTMLDivElement, root: Root;
const render = async () => { await act(async () => { root.render(<MigrationBanner />); }); };
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text))!;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks();
  mock.target = { url: 'https://vibe.example.com', name: 'Acme Vibe' }; mock.dismissed = {};
  Object.defineProperty(window, 'location', { value: { assign: mock.assign }, writable: true, configurable: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
it('renders for a targeted account and sends the browser to the ticket URL on click', async () => {
  mock.handoff.mockResolvedValue('https://vibe.example.com/login/migrate?handoff=vh1.x.y');
  await render();
  expect(host.textContent).toContain('migration.title:Very Happy,Acme Vibe');
  await act(async () => { button('migration.move').click(); });
  expect(mock.handoff).toHaveBeenCalledOnce();
  expect(mock.assign).toHaveBeenCalledWith('https://vibe.example.com/login/migrate?handoff=vh1.x.y');
});
it('stays hidden when the relay says nothing, or while a dismissal is fresh, and records "later" per target', async () => {
  mock.target = null; await render(); expect(host.textContent).toBe('');
  mock.target = { url: 'https://vibe.example.com', name: 'Acme Vibe' }; mock.dismissed = { 'migration:https://vibe.example.com': Date.now() - 1000 };
  await render(); expect(host.textContent).toBe('');
  mock.dismissed = {}; await render();
  await act(async () => { button('migration.later').click(); });
  expect(mock.setDismissed).toHaveBeenCalledWith({ 'migration:https://vibe.example.com': expect.any(Number) });
});
it('keeps the banner with an error when the ticket request fails', async () => {
  mock.handoff.mockRejectedValue(new Error('network'));
  await render();
  await act(async () => { button('migration.move').click(); });
  expect(host.querySelector('[role=alert]')?.textContent).toBe('migration.failed');
  expect(mock.assign).not.toHaveBeenCalled();
});
