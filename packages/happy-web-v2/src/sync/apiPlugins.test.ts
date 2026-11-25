import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth/AuthContext', () => ({ getCurrentAuth: () => ({ credentials: { token: 't' } }) }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://srv.test' }));
vi.mock('./apiSocket', () => ({ getHappyClientId: () => 'client' }));

const { approvePluginInstall, getPluginInstall, isPluginsUnavailable, listPluginInstalls, parseInstall, parseWidget, PluginsApiError, revokePluginGrants } = await import('./apiPlugins');
const store = await import('./pluginStore');

function stub(status: number, body: unknown) {
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  store.usePluginStore.setState({ availability: 'unknown', installs: {}, widgetsBySession: {}, badgeNonce: 0 });
});

// A wire `PluginInstallView` (PluginInstallViewSchema).
const RAW = { id: 'pi_1', machineId: 'm1', pluginId: 'hello-board', name: 'Hello', icon: 'kanban', version: '0.1.0', state: 'enabled', grants: ['sidebar', 'panel'], panels: [{ id: 'main', title: 'Main' }], origin: 'https://hello-board-aaaa.p.test', muted: false, lastSeenAt: null };

describe('apiPlugins parsing (wire schemas)', () => {
  it('accepts a wire PluginInstallView', () => {
    const i = parseInstall(RAW)!;
    expect(i.grants).toEqual(['sidebar', 'panel']);
    expect(i.origin).toBe('https://hello-board-aaaa.p.test');
  });

  it('drops rows that fail the schema; an origin with a path or another scheme becomes null', () => {
    expect(parseInstall({ ...RAW, id: undefined })).toBeNull();
    expect(parseInstall({ ...RAW, muted: undefined })).toBeNull();
    expect(parseInstall({ ...RAW, origin: 'https://x.test/path' })!.origin).toBeNull();
    expect(parseInstall({ ...RAW, origin: 'javascript:alert(1)' })!.origin).toBeNull();
  });

  it('widgets parse with the wire PluginWidgetViewSchema', () => {
    const w = parseWidget({ installId: 'pi_1', sessionId: 's', status: { label: 'x', tone: 'info' }, actions: [{ id: 'a', label: 'A' }], version: 2, updatedAt: 3 })!;
    expect(w.actions.map((a) => a.id)).toEqual(['a']);
    expect(parseWidget({ installId: 'pi_1', sessionId: 's', status: { label: 'x' }, actions: [], version: 1, updatedAt: 1 })).toBeNull();
  });
});

describe('apiPlugins routes', () => {
  it('lists installs', async () => {
    const calls = stub(200, { installs: [RAW, { junk: true }] });
    // one bad row is dropped, never the whole list
    expect((await listPluginInstalls()).map((i) => i.id)).toEqual(['pi_1']);
    expect(calls[0].url).toBe('https://srv.test/v1/plugins/installs');
  });

  it('approve posts grants + manifestHash', async () => {
    const calls = stub(200, { install: RAW });
    await approvePluginInstall('pi_1', ['sidebar'], 'abc');
    expect(calls[0]).toMatchObject({ url: 'https://srv.test/v1/plugins/installs/pi_1/approve', method: 'POST', body: { grants: ['sidebar'], manifestHash: 'abc' } });
  });

  it('revoke posts the revoke list', async () => {
    const calls = stub(200, { install: RAW });
    await revokePluginGrants('pi_1', ['panel']);
    expect(calls[0]).toMatchObject({ url: 'https://srv.test/v1/plugins/installs/pi_1/grants', body: { revoke: ['panel'] } });
  });

  it('409 manifest_changed surfaces its code', async () => {
    stub(409, { error: 'manifest_changed' });
    await expect(approvePluginInstall('pi_1', [], 'x')).rejects.toMatchObject({ status: 409, code: 'manifest_changed' });
  });

  it('detail parses the review manifest', async () => {
    const manifest = { schema: 'vh-plugin/v1', id: 'hello-board', name: 'Hello', version: '1.0.0', permissions: ['sidebar', 'panel', 'sessions.read'], sidebar: { title: 'H', panel: 'main' }, panels: [{ id: 'main', title: 'M', upstream: 'http://127.0.0.1:4310' }], callback: { url: 'http://127.0.0.1:4310/cb' } };
    stub(200, { install: { ...RAW, state: 'pending' }, review: { manifestHash: 'h', manifest, submittedAt: 5, machineId: 'm1' } });
    const d = await getPluginInstall('pi_1');
    expect(d.review.manifest.permissions).toEqual(['sidebar', 'panel', 'sessions.read']);
    expect(d.review.manifest.panels?.[0].upstream).toBe('http://127.0.0.1:4310');
    expect(d.review).toMatchObject({ submittedAt: 5, machineId: 'm1', approvedManifest: null });
    // a manifest that fails the wire schema is an invalid response, not a half-rendered review
    stub(200, { install: RAW, review: { manifestHash: 'h', manifest: { ...manifest, permissions: ['root'] }, submittedAt: 5, machineId: 'm1' } });
    await expect(getPluginInstall('pi_1')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('404 from an older server = unavailable; other errors are not', () => {
    expect(isPluginsUnavailable(new PluginsApiError(404, 'http_404'))).toBe(true);
    expect(isPluginsUnavailable(new PluginsApiError(404, 'route_not_found'))).toBe(true);
    expect(isPluginsUnavailable(new PluginsApiError(404, 'not_found'))).toBe(false);
    expect(isPluginsUnavailable(new PluginsApiError(500, 'http_500'))).toBe(false);
  });
});

describe('pluginStore', () => {
  it('older server 404 hides everything', async () => {
    stub(404, { error: 'route_not_found' });
    await store.loadPluginInstalls();
    expect(store.usePluginStore.getState().availability).toBe('unavailable');
  });

  it('a transient error keeps the previous list', async () => {
    store.setInstalls([parseInstall(RAW)!]);
    stub(500, {});
    await store.loadPluginInstalls();
    expect(store.usePluginStore.getState()).toMatchObject({ availability: 'available' });
    expect(Object.keys(store.usePluginStore.getState().installs)).toEqual(['pi_1']);
  });

  it('socket updates: install upsert / remove, widget upsert / remove, version never goes back', () => {
    expect(store.handlePluginUpdate({ t: 'plugin-install', install: RAW })).toBe(true);
    expect(store.usePluginStore.getState().installs.pi_1.name).toBe('Hello');
    // wire UpdatePluginWidgetBodySchema: the widget view itself carries `t`
    const w = { installId: 'pi_1', sessionId: 's1', status: { label: 'a', tone: 'info' }, actions: [], version: 2, updatedAt: 1 };
    // #1013 pushes the flat view plus a `widget` copy
    store.handlePluginUpdate({ t: 'plugin-widget', ...w, widget: w });
    store.handlePluginUpdate({ t: 'plugin-widget', ...w, status: { label: 'old', tone: 'info' }, version: 1 });
    expect(store.usePluginStore.getState().widgetsBySession.s1[0].status.label).toBe('a');
    store.handlePluginUpdate({ t: 'plugin-widget', installId: 'pi_1', sessionId: 's1', removed: true });
    expect(store.usePluginStore.getState().widgetsBySession.s1).toEqual([]);
    store.handlePluginUpdate({ t: 'plugin-install', install: { ...RAW, state: 'removed' } });
    expect(store.usePluginStore.getState().installs.pi_1).toBeUndefined();
    // #1013 removal shape
    store.handlePluginUpdate({ t: 'plugin-install', install: RAW });
    store.handlePluginUpdate({ t: 'plugin-install', installId: 'pi_1', removed: true });
    expect(store.usePluginStore.getState().installs.pi_1).toBeUndefined();
    // a malformed body is dropped alone
    expect(store.handlePluginUpdate({ t: 'plugin-install', install: { id: 'x' } })).toBe(true);
    expect(store.usePluginStore.getState().installs.x).toBeUndefined();
    expect(store.handlePluginUpdate({ t: 'new-message' })).toBe(false);
    // a sessionless / plugin attention item is kept away from session code; a session item is not touched
    expect(store.handlePluginUpdate({ t: 'attention-item', item: { id: 'a', source: 'plugin', sessionId: null } })).toBe(true);
    expect(store.handlePluginUpdate({ t: 'attention-item', item: { id: 'b', source: 'agent', sessionId: 's1' } })).toBe(false);
  });
});
