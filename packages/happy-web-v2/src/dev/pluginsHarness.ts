/**
 * DEV-only (B-974d): in-page `/v1/plugins*` for device captures before the
 * server lands. `#plugins` seeds four installs on `dev-machine`:
 * - Hello Board: enabled, attention badge 3, a widget on `dev-plain`, panel
 *   origin = `window.__vhPluginOrigin` (a local static page, see
 *   e2e/plugin-panel-fixture) or none;
 * - Inbox Relay: pending, asks for the sensitive `sessions.read`;
 * - Ops Board: update pending (upstream port changed, +panel);
 * - Old Tool: disabled by the operator.
 * `#plugins-off` answers 404 everywhere (older server). Calls are recorded on
 * `window.__pluginCalls`; nothing leaves the page.
 */
import { handlePluginUpdate } from '@/sync/pluginStore';

type Json = Record<string, unknown>;

export function installPluginsHarness(hash: string, machineId: string): () => void {
  const mode = hash === '#plugins-off' ? 'off' : hash.startsWith('#plugins') ? 'on' : null;
  if (!mode) return () => {};
  const zh = typeof navigator === 'undefined' || navigator.language.toLowerCase().startsWith('zh');
  const now = Date.now();
  const origin = (window as unknown as { __vhPluginOrigin?: string }).__vhPluginOrigin ?? null;
  const installs: Json[] = [
    {
      id: 'pi_hello',
      machineId,
      pluginId: 'hello-board',
      name: 'Hello Board',
      icon: 'kanban',
      version: '0.1.0',
      state: 'enabled',
      grants: ['sidebar', 'panel', 'decisions', 'session.widget'],
      sidebar: { title: 'Hello', panel: 'main' },
      panels: [{ id: 'main', title: zh ? '计数器' : 'Counter' }],
      badge: { count: 3, tone: 'attention', label: zh ? '等你 3' : '3 waiting', updatedAt: now },
      origin,
      lastSeenAt: now,
      muted: false,
    },
    {
      id: 'pi_inbox',
      machineId,
      pluginId: 'inbox-relay',
      name: 'Inbox Relay',
      icon: '📬',
      version: '1.2.0',
      state: 'pending',
      grants: [],
      panels: [],
      origin: null,
      muted: false,
      lastSeenAt: now,
    },
    {
      id: 'pi_ops',
      machineId,
      pluginId: 'ops-board',
      name: 'Ops Board',
      icon: 'chart',
      version: '2.0.0',
      state: 'update_pending',
      grants: ['sidebar', 'decisions'],
      sidebar: { title: 'Ops', panel: 'main' },
      panels: [{ id: 'main', title: 'Ops' }],
      badge: { count: 12, tone: 'default', updatedAt: now },
      origin,
      muted: false,
      lastSeenAt: now,
      pendingDiff: {
        manifestHash: 'b7e1c0aa55d2',
        version: '2.1.0',
        changes: [
          { field: 'panels[main].upstream', before: 'http://127.0.0.1:4400', after: 'http://127.0.0.1:4410', privileged: true },
          { field: 'version', before: '2.0.0', after: '2.1.0', privileged: false },
        ],
        addedPermissions: ['panel'],
        removedPermissions: [],
      },
    },
    { id: 'pi_old', machineId, pluginId: 'old-tool', name: 'Old Tool', icon: 'terminal', version: '0.0.9', state: 'disabled_by_operator', grants: ['decisions'], panels: [], origin: null, muted: false, lastSeenAt: null, stateReason: zh ? '在封禁名单中' : 'on the deny list' },
  ];
  const manifests: Record<string, Json> = {
    pi_hello: { schema: 'vh-plugin/v1', id: 'hello-board', name: 'Hello Board', version: '0.1.0', description: zh ? '演示四个扩展点：计数器面板、角标、决策卡、会话挂件' : 'Shows all four extension points: counter panel, badge, decision card, session widget', publisher: { name: 'Example' }, icon: 'kanban', permissions: ['sidebar', 'panel', 'decisions', 'session.widget'], sidebar: { title: 'Hello', panel: 'main' }, panels: [{ id: 'main', title: zh ? '计数器' : 'Counter', upstream: 'http://127.0.0.1:4310' }], callback: { url: 'http://127.0.0.1:4310/vh/callback' }, sessionWidget: true },
    pi_inbox: { schema: 'vh-plugin/v1', id: 'inbox-relay', name: 'Inbox Relay', version: '1.2.0', description: zh ? '把会话里的问题汇总到一个收件箱。' : 'Collects questions from your sessions into one inbox.', publisher: { name: 'Inbox Labs', url: 'https://example.com' }, icon: '📬', permissions: ['sidebar', 'panel', 'decisions', 'sessions.list', 'sessions.read'], sidebar: { title: 'Inbox', panel: 'main' }, panels: [{ id: 'main', title: 'Inbox', upstream: 'http://127.0.0.1:4520' }] },
    pi_ops: { schema: 'vh-plugin/v1', id: 'ops-board', name: 'Ops Board', version: '2.1.0', publisher: { name: 'Ops' }, icon: 'chart', permissions: ['sidebar', 'panel', 'decisions'], sidebar: { title: 'Ops', panel: 'main' }, panels: [{ id: 'main', title: 'Ops', upstream: 'http://127.0.0.1:4410' }], callback: { url: 'http://127.0.0.1:4410/hook' } },
    pi_old: { schema: 'vh-plugin/v1', id: 'old-tool', name: 'Old Tool', version: '0.0.9', icon: 'terminal', permissions: ['decisions'] },
  };
  const widgets: Json[] = [
    {
      installId: 'pi_hello',
      sessionId: 'dev-plain',
      status: { label: 'count: 7', tone: 'info' },
      text: zh ? '计数器在 7，到 10 会发一张决策卡。' : 'Counter is at 7; a decision card goes out at 10.',
      actions: [
        { id: 'inc', label: '+1', style: 'primary' },
        { id: 'reset', label: zh ? '清零' : 'Reset', style: 'danger', confirm: zh ? '把计数清零？' : 'Reset the counter?' },
      ],
      panelPath: '/',
      version: 1,
      updatedAt: now,
    },
  ];
  const pp = { v: 1, type: 'plugin', pluginId: 'hello-board', pluginName: 'Hello Board', machineId };
  // Complete wire AttentionItemAny rows (only the fields that matter here vary).
  const full = (o: Json): Json => ({ teamId: null, projectId: null, key: o.id, bodyMd: null, options: null, links: null, anchor: null, firstReply: null, replyToId: null, inferred: false, ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0, resolvedAt: null, pushedAt: null, payload: null, ...o });
  const decisions: Json[] = ([
    { id: 'att_sys', source: 'owner-system', pluginInstallId: 'pi_inbox', sessionId: null, kind: 'decision', state: 'open', needsOwner: true, version: 1, createdAt: now - 5 * 60_000, updatedAt: now - 5 * 60_000, title: zh ? '插件安装待批准：Inbox Relay' : 'Plugin waiting for approval: Inbox Relay' },
    {
      id: 'att_p1', source: 'plugin', pluginInstallId: 'pi_hello', sessionId: null, kind: 'decision', state: 'open', needsOwner: true, version: 1, createdAt: now - 3 * 60_000, updatedAt: now - 3 * 60_000,
      payload: { ...pp, decisionKind: 'choice', pluginState: 'open', optionStyles: { keep: 'primary', reset: 'danger' }, panelPath: '/#count' },
      title: zh ? '计数到 10 了：继续还是清零？' : 'The counter reached 10: keep going or reset?',
      bodyMd: zh ? '计数器已经到 **10**。清零后从 0 重新开始。\n\n规则见 [说明](https://example.com/hello-board/rules)。![chart](https://example.com/c.png)<b>raw</b>' : 'The counter is at **10**. Reset starts again from 0.\n\nSee [the rules](https://example.com/hello-board/rules). ![chart](https://example.com/c.png)<b>raw</b>',
      options: [{ id: 'keep', label: zh ? '继续' : 'Keep going' }, { id: 'reset', label: zh ? '清零' : 'Reset', detail: zh ? '计数归零' : 'Back to 0' }],
    },
    {
      id: 'att_p2', source: 'plugin', pluginInstallId: 'pi_hello', sessionId: null, kind: 'input', state: 'open', needsOwner: true, version: 1, createdAt: now - 60_000, updatedAt: now - 60_000,
      links: [{ type: 'session', ref: 'dev-plain' }],
      payload: { ...pp, decisionKind: 'input', pluginState: 'open', input: { placeholder: zh ? '写下你的决定，可以多行' : 'Write your decision (multiple lines ok)', maxLength: 2000, multiline: true } },
      title: zh ? '升级：要不要放行这次回复？' : 'Escalation: release this reply?', bodyMd: null,
    },
    {
      id: 'att_p3', source: 'plugin', pluginInstallId: 'pi_hello', sessionId: null, kind: 'decision', state: 'answered', needsOwner: false, version: 2, createdAt: now - 30 * 3600_000, updatedAt: now - 26 * 3600_000,
      payload: { ...pp, decisionKind: 'choice', pluginState: 'responded', delivery: 'pending', response: { action: 'choose', choice: 'keep', at: now - 26 * 3600_000 } },
      title: zh ? '计数到 5 了' : 'The counter reached 5', options: [{ id: 'keep', label: zh ? '继续' : 'Keep going' }, { id: 'reset', label: zh ? '清零' : 'Reset' }],
    },
  ] as Json[]).map(full);
  const calls: unknown[] = ((window as unknown as { __pluginCalls?: unknown[] }).__pluginCalls = []);
  const find = (id: string) => installs.find((i) => i.id === id);
  const push = (i: Json) => handlePluginUpdate({ t: 'plugin-install', install: i });

  const real = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url, location.href);
    const path = parsed.pathname;
    const isDecision = path.startsWith('/v1/attention-items') && (parsed.searchParams.get('include') === 'plugin' || decisions.some((d) => path.startsWith(`/v1/attention-items/${d.id}/`)));
    if (!path.startsWith('/v1/plugins') && !isDecision) return real(input, init);
    const method = init?.method ?? 'GET';
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Json;
    calls.push({ path, method, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (isDecision) {
      if (mode === 'off') return json(404, { error: 'owner_board_disabled' });
      if (method === 'GET') return json(200, { items: decisions });
      const d = decisions.find((x) => path === `/v1/attention-items/${x.id}/owner-respond`);
      if (!d) return json(404, { error: 'not_found' });
      const at = Date.now();
      Object.assign(d, { state: body.action === 'resolve' ? 'resolved' : 'answered', version: (d.version as number) + 1, updatedAt: at, payload: { ...(d.payload as Json), pluginState: 'responded', delivery: 'pending', response: { action: body.action === 'resolve' ? 'dismiss' : body.action, choice: body.choice, text: body.text, at } } });
      return json(200, { item: d });
    }
    if (mode === 'off') return json(404, { error: 'route_not_found' });
    if (path === '/v1/plugins/installs' && method === 'GET') return json(200, { installs });
    if (path === '/v1/plugins/widgets') return json(200, { widgets: widgets.filter((w) => w.sessionId === parsed.searchParams.get('sessionId')) });
    const w = path.match(/^\/v1\/plugins\/widgets\/([^/]+)\/([^/]+)\/action$/);
    if (w) return json(200, { eventId: `evt_${calls.length}` });
    const m = path.match(/^\/v1\/plugins\/installs\/([^/]+)(?:\/([a-z-]+))?$/);
    if (!m) return json(404, { error: 'not_found' });
    const i = find(decodeURIComponent(m[1]));
    if (!i) return json(404, { error: 'not_found' });
    const op = m[2];
    if (!op && method === 'GET') return json(200, { install: i, review: { manifest: manifests[i.id as string], manifestHash: i.state === 'update_pending' ? 'b7e1c0aa55d2' : `${String(i.id).slice(3)}0f3a9c21e7`, submittedAt: now - 5 * 60_000, machineId } });
    if (!op && method === 'DELETE') {
      installs.splice(installs.indexOf(i), 1);
      return json(200, { removed: true });
    }
    if (op === 'audit')
      return json(200, {
        entries: [
          { id: 'a3', at: now - 2 * 60_000, actor: 'plugin', action: 'badge.set', detail: 'count=3' },
          { id: 'a2', at: now - 40 * 60_000, actor: 'owner', action: 'install.approve', detail: 'sidebar, panel, decisions, session.widget' },
          { id: 'a1', at: now - 45 * 60_000, actor: 'machine', action: 'install.create' },
        ],
        sensitiveReads24h: 0,
      });
    if (op === 'frame-ticket') {
      if (!i.origin) return json(409, { error: 'plugin_host_unset' });
      const p = typeof body.path === 'string' ? body.path : '/';
      return json(200, { ticket: 't1', url: `${i.origin}/__vh/enter?t=t1&p=${encodeURIComponent(p)}` });
    }
    if (op === 'approve') {
      Object.assign(i, { state: 'enabled', grants: body.grants, pendingDiff: null });
    } else if (op === 'reject') Object.assign(i, { state: 'rejected' });
    else if (op === 'disable') Object.assign(i, { state: 'disabled' });
    else if (op === 'enable') Object.assign(i, { state: 'enabled' });
    else if (op === 'mute') Object.assign(i, { muted: body.muted === true });
    else if (op === 'grants') Object.assign(i, { grants: (i.grants as string[]).filter((g) => !(body.revoke as string[]).includes(g)) });
    else return json(404, { error: 'not_found' });
    push(i);
    return json(200, { install: i });
  };
  return () => {
    window.fetch = real;
  };
}
