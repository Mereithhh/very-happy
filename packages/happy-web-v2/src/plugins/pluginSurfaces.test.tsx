// @vitest-environment happy-dom
/**
 * B-974d: plugin cards and widgets as rendered — the source mark is always
 * there, plugin markdown never renders images or HTML and links ask first,
 * cards of a plugin without `decisions` (or disabled) are not shown, an input
 * card submits its text, widget actions with `confirm` ask before calling.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  confirm: vi.fn(async () => false),
  respond: vi.fn(async () => {}),
  action: vi.fn(async () => ({ eventId: 'e' })),
  open: vi.fn(),
}));
vi.mock('@/modal', () => ({ Modal: { confirm: h.confirm } }));
vi.mock('@/ui/Toast', async (orig) => ({ ...(await orig<typeof import('@/ui/Toast')>()), toast: { error: vi.fn(), success: vi.fn(), show: vi.fn() } }));
vi.mock('@/sync/pluginDecisions', async (orig) => ({ ...(await orig<typeof import('@/sync/pluginDecisions')>()), respondToPluginDecision: h.respond }));
vi.mock('@/sync/apiPlugins', async (orig) => ({ ...(await orig<typeof import('@/sync/apiPlugins')>()), sendWidgetAction: h.action }));
vi.mock('@/sync/storage', () => ({ useMachine: () => ({ id: 'm1', active: true, metadata: { displayName: 'devbox' } }), useAllMachines: () => [] }));
vi.mock('@/sync/sync', () => ({ sync: { onResume: () => () => {} } }));

const { PluginDecisionCard, OwnerSystemCardView, visibleDecisions } = await import('./PluginDecisions');
const { PluginWidgetCard } = await import('./PluginWidgets');
const { parsePluginDecision } = await import('@/sync/pluginDecisions');
const { attentionItem, pluginPayload } = await import('./testing/attentionFixture');
type Install = import('./pluginTypes').PluginInstallView;

const install: Install = { id: 'pi_1', machineId: 'm1', pluginId: 'p', name: 'Hello Board', icon: 'kanban', version: '1', state: 'enabled', grants: ['decisions', 'panel', 'session.widget'], panels: [{ id: 'main', title: 'M' }], origin: 'https://p.test', sidebar: { title: 'H', panel: 'main' }, muted: false, lastSeenAt: null };
const item = (over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) =>
  parsePluginDecision(attentionItem({ id: 'a1', pluginInstallId: 'pi_1', title: 'Keep going?', options: [{ id: 'keep', label: 'Keep' }, { id: 'reset', label: 'Reset' }], payload: pluginPayload({ pluginName: 'Hello Board', optionStyles: { reset: 'danger' }, ...payload }), ...over }))!;

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  h.confirm.mockReset();
  h.respond.mockClear();
  h.action.mockClear();
  vi.stubGlobal('open', h.open);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

let currentPath = '';
function LocationProbe() {
  currentPath = useLocation().pathname;
  return null;
}
async function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter>{node}<LocationProbe /></MemoryRouter>));
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

describe('PluginDecisionCard', () => {
  it('carries the source mark and renders no images or raw HTML; links show their host and ask first', async () => {
    h.confirm.mockResolvedValueOnce(false);
    await render(<PluginDecisionCard item={item({ bodyMd: 'See [rules](https://example.com/r) ![x](https://evil.test/p.png) <img src=x onerror=alert(1)><script>alert(1)</script> [js](javascript:alert(1))' })} install={install} machineName="devbox" />);
    expect(host.querySelector('[data-testid=plugin-source]')?.textContent).toContain('Plugin · Hello Board · devbox');
    expect(host.querySelectorAll('img, script').length).toBe(0);
    const links = [...host.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/r']);
    expect(host.textContent).toContain('(example.com)');
    await act(async () => links[0].click());
    expect(h.confirm).toHaveBeenCalledWith(expect.any(String), 'https://example.com/r', expect.anything());
    expect(h.open).not.toHaveBeenCalled();
  });

  it('choice buttons send choose', async () => {
    await render(<PluginDecisionCard item={item()} install={install} machineName={null} />);
    await act(async () => button('Reset').click());
    expect(h.respond).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), { action: 'choose', choice: 'reset' });
  });

  it('multiline input card (r3) submits the trimmed text', async () => {
    await render(<PluginDecisionCard item={item({ kind: 'input' }, { decisionKind: 'input', input: { placeholder: 'name', multiline: true } })} install={install} machineName={null} />);
    const input = host.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(input, '  Friday\nsprint  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Send').click());
    expect(h.respond).toHaveBeenCalledWith(expect.anything(), { action: 'submit', text: 'Friday\nsprint' });
  });

  it('notice card: 「Got it」 resolves', async () => {
    await render(<PluginDecisionCard item={item({ kind: 'report' }, { decisionKind: 'notice' })} install={install} machineName={null} />);
    await act(async () => button('Got it').click());
    expect(h.respond).toHaveBeenCalledWith(expect.anything(), { action: 'resolve' });
  });

  it('cards show only for live installs that hold `decisions`', () => {
    const items = [item(), item({ id: 'a2', pluginInstallId: 'pi_2' }), item({ id: 'a3', pluginInstallId: 'pi_3' }), item({ id: 'a4', state: 'resolved' }, { pluginState: 'closed' })];
    const installs = { pi_1: install, pi_2: { ...install, id: 'pi_2', grants: ['panel'] } as Install, pi_3: { ...install, id: 'pi_3', state: 'disabled' } as Install };
    expect(visibleDecisions(items, installs).map((x) => x.item.id)).toEqual(['a1']);
  });
});

describe('owner-system card', () => {
  it('「插件安装待批准」 opens the review page', async () => {
    await render(<OwnerSystemCardView card={{ id: 'o1', installId: 'pi_2', title: 'Plugin waiting for approval', bodyMd: null, open: true, version: 1, updatedAt: 1 }} />);
    const card = host.querySelector('[data-testid=plugin-system-card]') as HTMLButtonElement;
    expect(card.textContent).toContain('Plugin waiting for approval');
    await act(async () => card.click());
    expect(currentPath).toBe('/settings/plugins/pi_2/review');
  });

  it('titles the card in the viewer\'s language from the payload (B-974f)', async () => {
    await render(<OwnerSystemCardView card={{ id: 'o1', installId: 'pi_2', title: '插件安装待批准 · Hello Board', pluginName: 'Hello Board', update: false, bodyMd: null, open: true, version: 1, updatedAt: 1 }} />);
    expect(host.querySelector('[data-testid=plugin-system-card] .plg-card-title')!.textContent).toBe('Plugin waiting for approval · Hello Board');
    await render(<OwnerSystemCardView card={{ id: 'o1', installId: 'pi_2', title: '插件更新待批准 · Hello Board', pluginName: 'Hello Board', update: true, bodyMd: null, open: true, version: 1, updatedAt: 1 }} />);
    expect(host.querySelector('[data-testid=plugin-system-card] .plg-card-title')!.textContent).toBe('Plugin update waiting for approval · Hello Board');
  });
});

describe('PluginWidgetCard', () => {
  const widget = { installId: 'pi_1', sessionId: 's1', status: { label: 'count: 7', tone: 'info' as const }, text: '<b>plain</b>', actions: [{ id: 'inc', label: '+1' }, { id: 'reset', label: 'Reset', style: 'danger' as const, confirm: 'Reset the counter?' }], panelPath: '/', version: 1, updatedAt: 1 };

  it('text is plain; an action with confirm asks first and does nothing when declined', async () => {
    h.confirm.mockResolvedValueOnce(false);
    await render(<PluginWidgetCard widget={widget} install={install} onDone={() => {}} />);
    expect(host.querySelector('b')).toBeNull();
    expect(host.textContent).toContain('<b>plain</b>');
    await act(async () => button('Reset').click());
    expect(h.confirm).toHaveBeenCalledWith('Reset the counter?', expect.any(String), expect.anything());
    expect(h.action).not.toHaveBeenCalled();
    h.confirm.mockResolvedValueOnce(true);
    await act(async () => button('Reset').click());
    expect(h.action).toHaveBeenCalledWith('pi_1', 's1', 'reset');
  });

  it('an action without confirm calls straight away', async () => {
    await render(<PluginWidgetCard widget={widget} install={install} onDone={() => {}} />);
    await act(async () => button('+1').click());
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.action).toHaveBeenCalledWith('pi_1', 's1', 'inc');
  });
});
