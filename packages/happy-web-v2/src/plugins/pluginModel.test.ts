import { describe, expect, it } from 'vitest';
import { approvalGrants, canOpenPanel, formatBadge, iconKind, initialGrants, pluginAttentionTotal, sidebarInstalls, toggleGrant, visibleWidgets } from './pluginModel';
import type { PluginInstallView, PluginWidgetView } from './pluginTypes';

function inst(over: Partial<PluginInstallView> = {}): PluginInstallView {
  return { id: 'pi_1', machineId: 'm1', pluginId: 'p', name: 'P', icon: 'kanban', version: '1', state: 'enabled', grants: ['sidebar', 'panel', 'session.widget'], panels: [{ id: 'main', title: 'Main' }], origin: 'https://p-aaaa.p.test', sidebar: { title: 'P', panel: 'main' }, muted: false, lastSeenAt: null, ...over };
}

function widget(over: Partial<PluginWidgetView> = {}): PluginWidgetView {
  return { installId: 'pi_1', sessionId: 's1', status: { label: 'ok', tone: 'info' }, actions: [], version: 1, updatedAt: 1, ...over };
}

describe('grants on the review page', () => {
  it('sensitive items are never pre-checked; existing grants stay', () => {
    expect(initialGrants(['sidebar', 'panel', 'sessions.list', 'sessions.read'])).toEqual(['sidebar', 'panel']);
    expect(initialGrants(['sidebar', 'sessions.list'], ['sessions.list'])).toEqual(['sidebar', 'sessions.list']);
  });

  it('checking a sensitive item without the second confirmation changes nothing', () => {
    expect(toggleGrant(['sidebar'], 'sessions.read', true, false)).toEqual(['sidebar']);
    expect(toggleGrant(['sidebar'], 'sessions.read', true, true)).toEqual(['sidebar', 'sessions.read']);
    expect(toggleGrant(['sidebar'], 'panel', true, false)).toEqual(['sidebar', 'panel']);
    expect(toggleGrant(['sidebar', 'sessions.read'], 'sessions.read', false, false)).toEqual(['sidebar']);
  });

  it('approval sends only requested permissions in canonical order', () => {
    expect(approvalGrants(['panel', 'sidebar'], ['sessions.read', 'panel', 'sidebar'])).toEqual(['sidebar', 'panel']);
  });
});

describe('badges', () => {
  it('formats', () => {
    expect(formatBadge({ count: 3 })).toBe('3');
    expect(formatBadge({ count: 100 })).toBe('99+');
    expect(formatBadge({ count: 0 })).toBeNull();
    expect(formatBadge({ count: null })).toBeNull();
    expect(formatBadge(null)).toBeNull();
  });

  it('global total counts only attention, live, unmuted, sidebar-granted installs', () => {
    expect(
      pluginAttentionTotal([
        inst({ id: 'a', badge: { count: 3, tone: 'attention', updatedAt: 1 } }),
        inst({ id: 'b', badge: { count: 5, tone: 'default', updatedAt: 1 } }),
        inst({ id: 'c', badge: { count: 7, tone: 'attention', updatedAt: 1 }, muted: true }),
        inst({ id: 'd', badge: { count: 11, tone: 'attention', updatedAt: 1 }, state: 'disabled' }),
        inst({ id: 'e', badge: { count: 13, tone: 'attention', updatedAt: 1 }, grants: ['panel'] }),
        inst({ id: 'f', badge: { count: 2, tone: 'attention', updatedAt: 1 }, state: 'update_pending' }),
      ]),
    ).toBe(5);
  });

  it('sidebar shows live installs with the grant and a sidebar entry', () => {
    const rows = sidebarInstalls([inst({ id: 'b', name: 'B' }), inst({ id: 'a', name: 'A' }), inst({ id: 'x', state: 'pending' }), inst({ id: 'y', grants: ['panel'] }), inst({ id: 'z', sidebar: null })]);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('session widgets', () => {
  const session = { id: 's1', machineId: 'm1' };

  it('only installs on the session machine with session.widget', () => {
    const installs = [inst({ id: 'a' }), inst({ id: 'b', machineId: 'm2' }), inst({ id: 'c', grants: ['panel'] }), inst({ id: 'd', state: 'disabled' })];
    const ws = ['a', 'b', 'c', 'd'].map((id) => widget({ installId: id }));
    expect(visibleWidgets(ws, installs, session).map((w) => w.install.id)).toEqual(['a']);
  });

  it('at most 3 per session, oldest first; at most 2 actions; one per plugin', () => {
    const installs = ['a', 'b', 'c', 'd'].map((id) => inst({ id }));
    const ws = [
      widget({ installId: 'd', updatedAt: 1 }),
      widget({ installId: 'a', updatedAt: 2, actions: [{ id: '1', label: '1' }, { id: '2', label: '2' }, { id: '3', label: '3' }] }),
      widget({ installId: 'a', updatedAt: 2.5 }),
      widget({ installId: 'b', updatedAt: 3 }),
      widget({ installId: 'c', updatedAt: 4 }),
      widget({ installId: 'b', sessionId: 's2' }),
    ];
    const out = visibleWidgets(ws, installs, session);
    expect(out.map((w) => w.install.id)).toEqual(['d', 'a', 'b']);
    expect(out[1].widget.actions).toHaveLength(2);
  });

  it('archived sessions and unknown machines show nothing', () => {
    expect(visibleWidgets([widget()], [inst()], { ...session, archived: true })).toEqual([]);
    expect(visibleWidgets([widget()], [inst()], { id: 's1', machineId: null })).toEqual([]);
  });
});

describe('panels and icons', () => {
  it('panel needs origin, grant and a declared panel', () => {
    expect(canOpenPanel(inst(), 'main')).toBe(true);
    expect(canOpenPanel(inst({ origin: null }), 'main')).toBe(false);
    expect(canOpenPanel(inst({ grants: ['sidebar'] }), 'main')).toBe(false);
    expect(canOpenPanel(inst(), 'other')).toBe(false);
  });

  it('icons: builtin, single emoji, else puzzle (no URLs or SVG)', () => {
    expect(iconKind('bell')).toEqual({ kind: 'builtin', name: 'bell' });
    expect(iconKind('🚀')).toEqual({ kind: 'emoji', text: '🚀' });
    expect(iconKind('https://x/y.svg')).toEqual({ kind: 'builtin', name: 'puzzle' });
    expect(iconKind('<svg/>')).toEqual({ kind: 'builtin', name: 'puzzle' });
    expect(iconKind('🚀🚀')).toEqual({ kind: 'builtin', name: 'puzzle' });
  });
});
