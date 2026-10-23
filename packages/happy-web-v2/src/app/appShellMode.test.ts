import { describe, expect, it } from 'vitest';
import { appShellMode, nextSidebarParked, sidebarMounted } from './appShellMode';

const base = { settings: false, desktop: false, touchDrawer: false, collapsed: false, atRoot: false, firstRun: false, workspaceGuide: false };

describe('appShellMode', () => {
  it('pins the sidebar on a fine-pointer desktop and honours collapse', () => {
    expect(appShellMode({ ...base, desktop: true })).toBe('expanded');
    expect(appShellMode({ ...base, desktop: true, collapsed: true })).toBe('collapsed');
  });

  it('gives a medium touch screen (unfolded iPhone Duo 890×626) the drawer, whatever the collapse pref', () => {
    expect(appShellMode({ ...base, desktop: true, touchDrawer: true })).toBe('drawer');
    expect(appShellMode({ ...base, desktop: true, touchDrawer: true, collapsed: true })).toBe('drawer');
  });

  it('keeps phones on list / single, and settings single everywhere', () => {
    expect(appShellMode({ ...base, atRoot: true })).toBe('list');
    expect(appShellMode({ ...base, atRoot: true, firstRun: true })).toBe('single');
    expect(appShellMode({ ...base })).toBe('single');
    expect(appShellMode({ ...base, desktop: true, touchDrawer: true, settings: true })).toBe('single');
  });
});

describe('nextSidebarParked', () => {
  const at = (mode: Parameters<typeof sidebarMounted>[0], pathname = '/session/a') => ({ mode, pathname });

  it('parks the sidebar when folding drops it on the same route', () => {
    expect(nextSidebarParked(false, at('expanded'), at('single'))).toBe(true);
    expect(nextSidebarParked(false, at('drawer'), at('single'))).toBe(true);
  });

  it('stays parked through a round trip and unparks once the sidebar is back in the layout', () => {
    expect(nextSidebarParked(true, at('single'), at('single'))).toBe(true);
    expect(nextSidebarParked(true, at('single'), at('drawer'))).toBe(false);
  });

  it('drops the parked sidebar on navigation (phones keep their old cost)', () => {
    expect(nextSidebarParked(true, at('single'), at('single', '/session/b'))).toBe(false);
    expect(nextSidebarParked(false, at('list', '/'), at('single', '/session/b'))).toBe(false);
  });

  it('does not park for a user collapse', () => {
    expect(nextSidebarParked(false, at('expanded'), at('collapsed'))).toBe(false);
  });
});
