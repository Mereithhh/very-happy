// @vitest-environment happy-dom
/**
 * B-974e: a machine (or session) signed in with legacy CLI credentials has no
 * data key; the server answers `502 machine_unsupported` for its panel and
 * refuses widgets on its sessions. The panel page and the session header say
 * so in plain words and list the fix, instead of a blank frame or nothing.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  machine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { displayName: 'devbox' }, legacyKey: true } as Record<string, unknown>,
  session: { id: 's1', metadata: { machineId: 'm1' }, legacyKey: true, archivedAt: null } as Record<string, unknown>,
  ticket: vi.fn(async () => ({ url: 'https://pi.p.test/__vh/enter?t=x' })),
  widgets: vi.fn(async () => {}),
}));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn(async () => false) } }));
vi.mock('@/ui/Toast', async (orig) => ({ ...(await orig<typeof import('@/ui/Toast')>()), toast: { error: vi.fn(), success: vi.fn(), show: vi.fn() } }));
vi.mock('@/app/BackButton', () => ({ BackButton: () => null }));
vi.mock('@/ui/theme', async (orig) => ({ ...(await orig<typeof import('@/ui/theme')>()), useTheme: () => ({ resolved: 'light' }) }));
vi.mock('@/sync/storage', () => ({
  useMachine: (id: string) => (id === 'm1' ? h.machine : null),
  useSession: (id: string) => (id === 's1' ? h.session : null),
  useAllMachines: () => [],
  storage: { getState: () => ({ sessions: {} }) },
}));
vi.mock('@/sync/sync', () => ({ sync: { onResume: () => () => {} } }));
vi.mock('@/sync/apiPlugins', async (orig) => ({ ...(await orig<typeof import('@/sync/apiPlugins')>()), createFrameTicket: h.ticket }));
vi.mock('@/sync/pluginStore', async (orig) => ({ ...(await orig<typeof import('@/sync/pluginStore')>()), loadSessionWidgets: h.widgets }));

const { usePluginStore } = await import('@/sync/pluginStore');
const { PluginsApiError } = await import('@/sync/apiPlugins');
const { PluginPanelScreen } = await import('./PluginPanelScreen');
const { PluginWidgetChips, legacyWidgetInstall } = await import('./PluginWidgets');
const { legacyFixCommands } = await import('./LegacyCredentialsNotice');
type Install = import('./pluginTypes').PluginInstallView;

const install: Install = { id: 'pi_1', machineId: 'm1', pluginId: 'hello-board', name: 'Hello Board', icon: 'kanban', version: '1', state: 'enabled', grants: ['panel', 'session.widget'], panels: [{ id: 'main', title: 'M' }], origin: 'https://pi.p.test', sidebar: { title: 'H', panel: 'main' }, muted: false, lastSeenAt: null };

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  h.machine.legacyKey = true;
  h.session.legacyKey = true;
  h.ticket.mockReset();
  h.ticket.mockResolvedValue({ url: 'https://pi.p.test/__vh/enter?t=x' });
  usePluginStore.setState({ availability: 'available', installs: { pi_1: install }, widgetsBySession: {} });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function render(node: React.ReactNode, path = '/') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>));
  await act(async () => {});
}
const panel = () => render(<Routes><Route path="/plugins/:installId/:panelId" element={<PluginPanelScreen />} /></Routes>, '/plugins/pi_1/main');

describe('legacy credentials: panel page', () => {
  it('a legacy machine shows the fix, with the exact commands, and never asks for a ticket', async () => {
    await panel();
    const notice = host.querySelector('[data-testid=plugin-legacy-notice]');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain('devbox is signed in the old way');
    const commands = [...notice!.querySelectorAll('code')].map((c) => c.textContent);
    expect(commands).toEqual(['very-happy plugin remove hello-board', 'very-happy auth login --force', 'very-happy daemon start', 'very-happy plugin add <manifest>']);
    expect(host.querySelector('iframe')).toBeNull();
    expect(h.ticket).not.toHaveBeenCalled();
  });

  it('a 502 machine_unsupported from the server shows the same fix, not the generic error', async () => {
    h.machine.legacyKey = false;
    h.ticket.mockRejectedValueOnce(new PluginsApiError(502, 'machine_unsupported'));
    await panel();
    expect(host.querySelector('[data-testid=plugin-legacy-notice]')).not.toBeNull();
    expect(host.textContent).not.toContain('Could not open the panel');
  });

  it('a machine with a data key loads the panel as before', async () => {
    h.machine.legacyKey = false;
    await panel();
    expect(h.ticket).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid=plugin-legacy-notice]')).toBeNull();
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe('https://pi.p.test/__vh/enter?t=x');
  });

  it('other errors keep the generic message', async () => {
    h.machine.legacyKey = false;
    h.ticket.mockRejectedValueOnce(new PluginsApiError(504, 'upstream_timeout'));
    await panel();
    expect(host.querySelector('[data-testid=plugin-legacy-notice]')).toBeNull();
    expect(host.textContent).toContain('Could not open the panel (upstream_timeout)');
  });
});

describe('legacy credentials: session widgets', () => {
  it('a legacy session whose machine has a widget plugin shows one warning chip with the fix', async () => {
    await render(<PluginWidgetChips sessionId="s1" />);
    const chip = host.querySelector('button[data-legacy]') as HTMLButtonElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain('Plugin unavailable');
    await act(async () => chip.click());
    const notice = document.body.querySelector('[data-testid=plugin-legacy-notice]');
    expect(notice?.textContent).toContain('very-happy auth login --force');
    expect(document.body.querySelector('[data-testid=plugin-source]')?.textContent).toContain('Hello Board');
  });

  it('nothing for a session with a data key, an archived one, or without a widget plugin', async () => {
    h.session.legacyKey = false;
    await render(<PluginWidgetChips sessionId="s1" />);
    expect(host.querySelector('[data-testid=plugin-widget-chips]')).toBeNull();
    expect(legacyWidgetInstall([{ ...install, grants: ['panel'] }], 'm1')).toBeNull();
    expect(legacyWidgetInstall([{ ...install, state: 'disabled' }], 'm1')).toBeNull();
    expect(legacyWidgetInstall([install], 'm2')).toBeNull();
    expect(legacyWidgetInstall([install], undefined)).toBeNull();
  });

  it('the fix starts with plugin remove, so a later add is not refused as already installed', () => {
    expect(legacyFixCommands('x')[0]).toBe('very-happy plugin remove x');
  });
});
