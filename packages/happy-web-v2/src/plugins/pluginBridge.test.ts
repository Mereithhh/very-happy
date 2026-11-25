import { describe, expect, it, vi } from 'vitest';
import { PluginBridge, RateLimiter, externalUrl, type BridgeHost } from './pluginBridge';
import type { PluginInstallView } from './pluginTypes';

const ORIGIN = 'https://hello-board-abcd1234.p.example.test';

function install(over: Partial<PluginInstallView> = {}): PluginInstallView {
  return {
    id: 'pi_1',
    machineId: 'm1',
    pluginId: 'hello-board',
    name: 'Hello Board',
    icon: 'kanban',
    version: '0.1.0',
    state: 'enabled',
    grants: ['sidebar', 'panel', 'decisions', 'session.widget'],
    panels: [{ id: 'main', title: '计数器' }, { id: 'side', title: 'Side' }],
    origin: ORIGIN,
    muted: false,
    lastSeenAt: null,
    ...over,
  };
}

function setup(opts: { install?: () => PluginInstallView | null; now?: () => number; confirm?: boolean } = {}) {
  const frame = { postMessage: vi.fn() };
  let current: PluginInstallView | null = install();
  const host: BridgeHost = {
    getInstall: vi.fn(opts.install ?? (() => current)),
    theme: () => 'dark',
    locale: () => 'zh-CN',
    mobile: () => false,
    setTitle: vi.fn(),
    navigatePanel: vi.fn(),
    isSessionOnMachine: vi.fn((sid: string, mid: string) => sid === 's-local' && mid === 'm1'),
    navigateSession: vi.fn(),
    confirmExternal: vi.fn(async () => opts.confirm ?? true),
    openExternal: vi.fn(),
    refreshBadge: vi.fn(),
  };
  const bridge = new PluginBridge({ origin: ORIGIN, panelId: 'main', frameWindow: () => frame, host, now: opts.now });
  const send = (data: unknown, over: { source?: unknown; origin?: string } = {}) =>
    bridge.handle({ source: 'source' in over ? over.source : frame, origin: over.origin ?? ORIGIN, data });
  return { frame, host, bridge, send, setInstall: (i: PluginInstallView | null) => (current = i) };
}

describe('PluginBridge origin/source checks (§4.4)', () => {
  it('handles a message from the iframe window at the install origin and replies to that origin only', async () => {
    const { send, frame } = setup();
    const reply = await send({ vh: 1, id: 1, method: 'host.hello' });
    expect(reply).toMatchObject({ ok: true, result: { apiVersion: 1, installId: 'pi_1', panelId: 'main', theme: 'dark', locale: 'zh-CN', mobile: false } });
    expect(frame.postMessage).toHaveBeenCalledTimes(1);
    expect(frame.postMessage.mock.calls[0][1]).toBe(ORIGIN);
  });

  it('hello carries no token, account or session data', async () => {
    const { send } = setup();
    const reply = await send({ vh: 1, id: 1, method: 'host.hello' });
    expect(Object.keys((reply as { result: object }).result).sort()).toEqual(['apiVersion', 'installId', 'locale', 'mobile', 'panelId', 'theme']);
  });

  it('ignores a message with the right origin from another window', async () => {
    const { send, frame } = setup();
    expect(await send({ vh: 1, id: 1, method: 'host.hello' }, { source: { postMessage: vi.fn() } })).toBeNull();
    expect(await send({ vh: 1, id: 1, method: 'host.hello' }, { source: null })).toBeNull();
    expect(frame.postMessage).not.toHaveBeenCalled();
  });

  it('ignores a message from the iframe window at another origin (sibling plugin, host itself, opaque)', async () => {
    const { send, frame } = setup();
    for (const origin of ['https://other-plugin-ffff0000.p.example.test', 'https://app.example.test', 'null', `${ORIGIN}:443`, 'http://hello-board-abcd1234.p.example.test']) {
      expect(await send({ vh: 1, id: 1, method: 'host.hello' }, { origin })).toBeNull();
    }
    expect(frame.postMessage).not.toHaveBeenCalled();
  });

  it('accepts nothing when the configured origin is unusable', async () => {
    const frame = { postMessage: vi.fn() };
    const bridge = new PluginBridge({ origin: 'not a url', panelId: 'main', frameWindow: () => frame, host: setup().host });
    expect(await bridge.handle({ source: frame, origin: 'null', data: { vh: 1, id: 1, method: 'host.hello' } })).toBeNull();
  });

  it('ignores non-envelope data', async () => {
    const { send, frame } = setup();
    for (const data of [null, 'x', { id: 1, method: 'host.hello' }, { vh: 2, id: 1, method: 'host.hello' }, { vh: 1, method: 'host.hello' }, { vh: 1, id: 'x'.repeat(65), method: 'host.hello' }]) {
      expect(await send(data)).toBeNull();
    }
    expect(frame.postMessage).not.toHaveBeenCalled();
  });
});

describe('PluginBridge permission checks use the current grant', () => {
  it('rejects unknown methods', async () => {
    const { send } = setup();
    expect(await send({ vh: 1, id: 1, method: 'host.readSessions' })).toMatchObject({ ok: false, error: { code: 'unknown_method' } });
  });

  it('re-reads the install on every call — a revoke between two calls takes effect immediately', async () => {
    const { send, setInstall, host } = setup();
    expect(await send({ vh: 1, id: 1, method: 'host.setTitle', params: { title: 'A' } })).toMatchObject({ ok: true });
    setInstall(install({ grants: ['sidebar'] }));
    expect(await send({ vh: 1, id: 2, method: 'host.setTitle', params: { title: 'B' } })).toMatchObject({ ok: false, error: { code: 'permission_denied', permission: 'panel' } });
    expect(host.setTitle).toHaveBeenCalledTimes(1);
    expect(host.getInstall).toHaveBeenCalledTimes(2);
  });

  it('disabled / rejected / pending / operator-disabled installs get plugin_disabled', async () => {
    for (const state of ['disabled', 'rejected', 'pending', 'disabled_by_operator'] as const) {
      const { send } = setup({ install: () => install({ state }) });
      expect(await send({ vh: 1, id: 1, method: 'host.hello' })).toMatchObject({ ok: false, error: { code: 'plugin_disabled' } });
    }
    const { send } = setup({ install: () => null });
    expect(await send({ vh: 1, id: 1, method: 'host.hello' })).toMatchObject({ ok: false, error: { code: 'plugin_disabled' } });
  });

  it('update_pending keeps the old grants working (§3.3)', async () => {
    const { send } = setup({ install: () => install({ state: 'update_pending' }) });
    expect(await send({ vh: 1, id: 1, method: 'host.hello' })).toMatchObject({ ok: true });
  });

  it('badge.refresh needs sidebar, not panel', async () => {
    const { send, host } = setup({ install: () => install({ grants: ['panel'] }) });
    expect(await send({ vh: 1, id: 1, method: 'host.badge.refresh' })).toMatchObject({ ok: false, error: { code: 'permission_denied', permission: 'sidebar' } });
    expect(host.refreshBadge).not.toHaveBeenCalled();
  });

  it('navigate to a session needs panel + session.widget and a session on this machine', async () => {
    const noWidget = setup({ install: () => install({ grants: ['panel'] }) });
    expect(await noWidget.send({ vh: 1, id: 1, method: 'host.navigate', params: { to: 'session', sessionId: 's-local' } })).toMatchObject({ ok: false, error: { code: 'permission_denied', permission: 'session.widget' } });
    const ok = setup();
    expect(await ok.send({ vh: 1, id: 2, method: 'host.navigate', params: { to: 'session', sessionId: 's-other' } })).toMatchObject({ ok: false, error: { code: 'session_not_on_machine' } });
    expect(ok.host.navigateSession).not.toHaveBeenCalled();
    expect(await ok.send({ vh: 1, id: 3, method: 'host.navigate', params: { to: 'session', sessionId: 's-local' } })).toMatchObject({ ok: true });
    expect(ok.host.navigateSession).toHaveBeenCalledWith('s-local');
  });

  it('navigate to a panel only within the same plugin', async () => {
    const { send, host } = setup();
    expect(await send({ vh: 1, id: 1, method: 'host.navigate', params: { to: 'panel', panelId: 'nope' } })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await send({ vh: 1, id: 2, method: 'host.navigate', params: { to: 'panel', panelId: 'side', path: '//evil.test/x' } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await send({ vh: 1, id: 3, method: 'host.navigate', params: { to: 'panel', panelId: 'side', path: '/a?b=1' } })).toMatchObject({ ok: true });
    expect(host.navigatePanel).toHaveBeenCalledWith('side', '/a?b=1');
  });
});

describe('PluginBridge openExternal', () => {
  it('only https, confirmed by the host first', async () => {
    const { send, host } = setup();
    expect(await send({ vh: 1, id: 1, method: 'host.openExternal', params: { url: 'javascript:alert(1)' } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await send({ vh: 1, id: 2, method: 'host.openExternal', params: { url: 'http://example.test' } })).toMatchObject({ ok: false });
    expect(host.confirmExternal).not.toHaveBeenCalled();
    expect(await send({ vh: 1, id: 3, method: 'host.openExternal', params: { url: 'https://example.test/a' } })).toMatchObject({ ok: true });
    expect(host.confirmExternal).toHaveBeenCalledWith('https://example.test/a');
    expect(host.openExternal).toHaveBeenCalledWith('https://example.test/a');
  });

  it('does not open when the owner cancels', async () => {
    const { send, host } = setup({ confirm: false });
    expect(await send({ vh: 1, id: 1, method: 'host.openExternal', params: { url: 'https://example.test' } })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(host.openExternal).not.toHaveBeenCalled();
  });

  it('does not open when the plugin was disabled while the confirm was up', async () => {
    const ctx = setup();
    (ctx.host.confirmExternal as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      ctx.setInstall(install({ state: 'disabled' }));
      return true;
    });
    expect(await ctx.send({ vh: 1, id: 1, method: 'host.openExternal', params: { url: 'https://example.test' } })).toMatchObject({ ok: false, error: { code: 'plugin_disabled' } });
    expect(ctx.host.openExternal).not.toHaveBeenCalled();
  });
});

describe('PluginBridge rate limit (20/s per iframe)', () => {
  it('the 21st call within a second is rate_limited, and the window slides', async () => {
    let t = 1000;
    const { send, host } = setup({ now: () => t });
    for (let i = 0; i < 20; i++) expect(await send({ vh: 1, id: i, method: 'host.badge.refresh' })).toMatchObject({ ok: true });
    expect(await send({ vh: 1, id: 20, method: 'host.badge.refresh' })).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(host.refreshBadge).toHaveBeenCalledTimes(20);
    t += 1000;
    expect(await send({ vh: 1, id: 21, method: 'host.badge.refresh' })).toMatchObject({ ok: true });
  });

  it('RateLimiter boundary', () => {
    const r = new RateLimiter(2, 100);
    expect(r.take(0)).toBe(true);
    expect(r.take(50)).toBe(true);
    expect(r.take(99)).toBe(false);
    expect(r.take(100)).toBe(true);
  });
});

describe('theme notifications', () => {
  it('only after subscribe and while panel is granted', async () => {
    const ctx = setup();
    expect(ctx.bridge.notifyTheme('light')).toBe(false);
    await ctx.send({ vh: 1, id: 1, method: 'host.theme.subscribe' });
    expect(ctx.bridge.notifyTheme('light')).toBe(true);
    expect(ctx.frame.postMessage).toHaveBeenLastCalledWith({ vh: 1, event: 'host.themeChanged', params: { theme: 'light' } }, ORIGIN);
    ctx.setInstall(install({ grants: ['sidebar'] }));
    expect(ctx.bridge.notifyTheme('dark')).toBe(false);
  });
});

describe('request validation (wire PluginBridgeRequestSchema)', () => {
  it('setTitle: trimmed, ≤40, no control or bidi characters', async () => {
    const { send, host } = setup();
    expect(await send({ vh: 1, id: 1, method: 'host.setTitle', params: { title: 'a\u0007b' } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await send({ vh: 1, id: 2, method: 'host.setTitle', params: { title: 'x'.repeat(41) } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await send({ vh: 1, id: 3, method: 'host.setTitle', params: { title: 'evil\u202Etxt' } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await send({ vh: 1, id: 4, method: 'host.setTitle', params: { title: '  Counter ' } })).toMatchObject({ ok: true, result: { title: 'Counter' } });
    expect(host.setTitle).toHaveBeenCalledTimes(1);
  });

  it('navigate panel path: origin-relative only; #fragment allowed (r3)', async () => {
    const { send, host } = setup();
    for (const path of ['x', '//h/a', '/a\\b', '/../etc', 'https://h/']) {
      expect(await send({ vh: 1, id: path, method: 'host.navigate', params: { to: 'panel', panelId: 'side', path } })).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    }
    expect(await send({ vh: 1, id: 9, method: 'host.navigate', params: { to: 'panel', panelId: 'side', path: '/case/3#esc' } })).toMatchObject({ ok: true });
    expect(host.navigatePanel).toHaveBeenCalledWith('side', '/case/3#esc');
  });

  it('external url: https without credentials', () => {
    expect(externalUrl('https://a.test/x?y')).toBe('https://a.test/x?y');
    expect(externalUrl('https://u:p@a.test')).toBeNull();
    expect(externalUrl('data:text/html,x')).toBeNull();
  });
});
