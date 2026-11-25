// @vitest-environment happy-dom
/**
 * B-974d: the plugin review page as rendered — sensitive permissions start
 * unchecked and need the second confirmation, approve sends exactly the
 * checked grants with the reviewed manifestHash, a 409 manifest_changed
 * reloads the new version, and an update shows its changed lines.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  detail: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  confirm: vi.fn(async () => true),
}));

vi.mock('@/sync/apiPlugins', async (orig) => ({
  ...(await orig<typeof import('@/sync/apiPlugins')>()),
  getPluginInstall: h.detail,
  approvePluginInstall: h.approve,
  rejectPluginInstall: h.reject,
  listPluginInstalls: vi.fn(async () => []),
}));
vi.mock('@/sync/storage', () => ({ useMachine: () => ({ id: 'm1', active: true, metadata: { displayName: 'devbox' } }) }));
vi.mock('@/modal', () => ({ Modal: { confirm: h.confirm } }));
vi.mock('@/ui/Toast', async (orig) => ({ ...(await orig<typeof import('@/ui/Toast')>()), toast: { error: vi.fn(), success: vi.fn(), show: vi.fn() } }));

const { PluginsApiError } = await import('@/sync/apiPlugins');
const { PluginReviewSettings } = await import('./PluginsSettings');

const manifest = {
  schema: 'vh-plugin/v1',
  id: 'hello-board',
  name: 'Hello Board',
  version: '0.1.0',
  description: 'demo',
  publisher: { name: 'Example' },
  icon: 'kanban',
  permissions: ['sidebar', 'panel', 'sessions.read'],
  panels: [{ id: 'main', title: '计数器', upstream: 'http://127.0.0.1:4310' }],
  callback: { url: 'http://127.0.0.1:4310/vh/callback' },
};
const install = { id: 'pi_1', machineId: 'm1', pluginId: 'hello-board', name: 'Hello Board', icon: 'kanban', version: '0.1.0', state: 'pending', grants: [], panels: [{ id: 'main', title: '计数器' }], origin: null, muted: false, lastSeenAt: null };

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  h.detail.mockReset();
  h.approve.mockReset();
  h.confirm.mockReset();
  h.detail.mockResolvedValue({ install, review: { manifest, manifestHash: 'hash-1', submittedAt: 1, machineId: 'm1', approvedManifest: null } });
  h.approve.mockResolvedValue({ ...install, state: 'enabled', grants: ['sidebar', 'panel'] });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/settings/plugins/pi_1/review']}>
        <Routes>
          <Route path="/settings/plugins/:installId/review" element={<PluginReviewSettings />} />
          <Route path="/settings/plugins/:installId" element={<div>detail</div>} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => {});
}

function boxes(): HTMLInputElement[] {
  return [...host.querySelectorAll<HTMLInputElement>('.plg-perm input[type=checkbox]')];
}
function button(text: string): HTMLButtonElement {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no button ${text}`);
  return b as HTMLButtonElement;
}

describe('PluginReviewSettings', () => {
  it('shows identity, unverified publisher, hash prefix, addresses; sensitive item unchecked', async () => {
    await render();
    const text = host.textContent ?? '';
    expect(text).toContain('Hello Board');
    expect(text).toContain('Unverified');
    expect(text).toContain('hash-1'.slice(0, 8));
    expect(text).toContain('http://127.0.0.1:4310');
    expect(text).toContain('http://127.0.0.1:4310/vh/callback');
    expect(boxes().map((b) => b.checked)).toEqual([true, true, false]);
    expect(host.querySelector('.plg-perm[data-risk="sensitive"]')).not.toBeNull();
  });

  it('checking a sensitive item asks again; declining leaves it unchecked', async () => {
    await render();
    h.confirm.mockResolvedValueOnce(false);
    await act(async () => boxes()[2].click());
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(boxes()[2].checked).toBe(false);
    await act(async () => button('Approve').click());
    expect(h.approve).toHaveBeenCalledWith('pi_1', ['sidebar', 'panel'], 'hash-1');
  });

  it('confirming the sensitive item includes it in the approval', async () => {
    await render();
    h.confirm.mockResolvedValueOnce(true);
    await act(async () => boxes()[2].click());
    expect(boxes()[2].checked).toBe(true);
    await act(async () => button('Approve').click());
    expect(h.approve).toHaveBeenCalledWith('pi_1', ['sidebar', 'panel', 'sessions.read'], 'hash-1');
  });

  it('unchecking a normal item needs no confirmation', async () => {
    await render();
    await act(async () => boxes()[1].click());
    expect(h.confirm).not.toHaveBeenCalled();
    await act(async () => button('Approve').click());
    expect(h.approve).toHaveBeenCalledWith('pi_1', ['sidebar'], 'hash-1');
  });

  it('409 manifest_changed reloads and shows the notice; next approve uses the new hash', async () => {
    await render();
    h.approve.mockRejectedValueOnce(new PluginsApiError(409, 'manifest_changed'));
    h.detail.mockResolvedValue({ install, review: { manifest, manifestHash: 'hash-2', submittedAt: 1, machineId: 'm1', approvedManifest: null } });
    await act(async () => button('Approve').click());
    await act(async () => {});
    expect(host.textContent).toContain('The manifest changed during your review');
    await act(async () => button('Approve').click());
    expect(h.approve).toHaveBeenLastCalledWith('pi_1', ['sidebar', 'panel'], 'hash-2');
  });

  it('an update lists its changes and keeps granted items checked', async () => {
    h.detail.mockResolvedValue({
      install: {
        ...install,
        state: 'update_pending',
        grants: ['sidebar'],
        pendingDiff: { manifestHash: 'hash-3', version: '0.2.0', changes: [{ field: 'panels[main].upstream', before: 'http://127.0.0.1:4310', after: 'http://127.0.0.1:4999', privileged: true }], addedPermissions: ['panel'], removedPermissions: [] },
      },
      review: { manifest, manifestHash: 'hash-3', submittedAt: 1, machineId: 'm1', approvedManifest: null },
    });
    await render();
    const text = host.textContent ?? '';
    expect(text).toContain('Review plugin update');
    expect(text).toContain('panels[main].upstream');
    expect(text).toContain('http://127.0.0.1:4999');
    expect(text).toContain('needs approval');
    expect(text).toContain('keeps running with its approved manifest');
    expect(boxes().map((b) => b.checked)).toEqual([true, true, false]);
  });
});
