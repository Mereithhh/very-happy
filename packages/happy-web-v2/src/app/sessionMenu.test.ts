/**
 * B-756: the sidebar row (⋯ + right-click / long-press) and the session header
 * ⋯ list a session's actions from ONE builder behind ONE gate.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildSessionMenu, sessionLink, sessionMenuAvailability, withSessionTools, type SessionMenuInput } from './sessionMenu';
import type { MenuItemDef } from '@/ui';

const t = (key: string, params?: { level?: string }) => (params?.level ? `${key}:${params.level}` : key);
const noop = () => {};
const full = (extra: Partial<SessionMenuInput> = {}): SessionMenuInput => ({
  t, zh: false,
  onShare: noop, onRename: noop, onTags: noop,
  project: { move: 'Move to project…', leave: { label: 'Remove from "P"' } },
  onMoveToProject: noop, onLeaveProject: noop,
  priority: { level: null, onSet: noop },
  onCopyLink: noop, onStop: noop, onArchive: noop,
  ...extra,
});
const keys = (input: SessionMenuInput) => buildSessionMenu(input).map((i) => i.key);

describe('buildSessionMenu', () => {
  it('lists share, rename, tags, project, priority, copy link, stop and archive in one fixed order', () => {
    expect(keys(full())).toEqual(['share', 'rename', 'tags', 'move-project', 'leave-project', 'priority', 'copy-link', 'stop', 'archive']);
  });
  it('an absent handler hides its item (shared / archived / idle sessions)', () => {
    expect(keys(full({ onShare: undefined, onStop: undefined, onLeaveProject: undefined }))).toEqual(['rename', 'tags', 'move-project', 'priority', 'copy-link', 'archive']);
    expect(keys({ t, zh: false, onCopyLink: noop })).toEqual(['copy-link']);
  });
  it('project entries need both the label (projects ready) and the handler', () => {
    expect(keys(full({ project: { move: null, leave: null } }))).not.toContain('move-project');
    expect(keys(full({ onMoveToProject: undefined }))).not.toContain('move-project');
  });
  it('share opens the share panel, stop runs only its own handler', () => {
    const onShare = vi.fn();
    const onStop = vi.fn();
    const items = buildSessionMenu(full({ onShare, onStop }));
    items.find((i) => i.key === 'share')!.onSelect();
    items.find((i) => i.key === 'stop')!.onSelect();
    expect(onShare).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(items.find((i) => i.key === 'share')!.label).toBe('share.menu');
  });
  it('B-798: priority is ONE row of checkable P0/P1/P2 choices and the current level clears', () => {
    const onSet = vi.fn();
    const items = buildSessionMenu(full({ priority: { level: 1, onSet } }));
    const row = items.find((i) => i.key === 'priority')!;
    expect(items.filter((i) => i.key.startsWith('priority'))).toHaveLength(1);
    expect(row.choices!.map((c) => [c.label, c.checked])).toEqual([['P0', false], ['P1', true], ['P2', false]]);
    expect(row.separatorBefore).toBe(true);
    row.choices!.find((c) => c.key === 'priority-1')!.onSelect();
    row.choices!.find((c) => c.key === 'priority-0')!.onSelect();
    expect(onSet.mock.calls).toEqual([[null], [0]]);
    expect(buildSessionMenu(full({ zh: true })).find((i) => i.key === 'priority')!.label).toBe('优先级');
  });
  it('a terminal closes (neutral) instead of archiving (danger)', () => {
    const archive = buildSessionMenu(full()).find((i) => i.key === 'archive')!;
    const close = buildSessionMenu(full({ isTerminal: true })).find((i) => i.key === 'archive')!;
    expect([archive.label, archive.danger]).toEqual(['common.archive', true]);
    expect([close.label, close.danger]).toEqual(['common.close', false]);
  });
  it('labels follow the language', () => {
    const zh = buildSessionMenu(full({ zh: true }));
    expect(zh.find((i) => i.key === 'copy-link')!.label).toBe('复制链接');
    expect(zh.find((i) => i.key === 'stop')!.label).toBe('停止');
    expect(zh.find((i) => i.key === 'tags')!.label).toBe('标签…');
  });
});

describe('sessionMenuAvailability', () => {
  it('my active session: everything; stop only while running', () => {
    expect(sessionMenuAvailability({ archivedAt: null }, { running: true, mirror: false })).toEqual({ share: true, rename: true, tags: true, priority: true, copyLink: true, stop: true, archive: true });
    expect(sessionMenuAvailability({ archivedAt: null }, { running: false, mirror: false }).stop).toBe(false);
  });
  it('archived: no share, no re-archive; mirror: no share', () => {
    const archived = sessionMenuAvailability({ archivedAt: 5 }, { running: false, mirror: false });
    expect([archived.share, archived.archive, archived.rename]).toEqual([false, false, true]);
    expect(sessionMenuAvailability({ archivedAt: null }, { running: false, mirror: true }).share).toBe(false);
  });
  it('shared with me: only copy link (everything else writes the owner’s session)', () => {
    expect(sessionMenuAvailability({ archivedAt: null, share: { role: 'driver' } }, { running: true, mirror: false })).toEqual({ share: false, rename: false, tags: false, priority: false, copyLink: true, stop: false, archive: false });
  });
});

describe('sessionLink', () => {
  it('joins origin and href once', () => {
    expect(sessionLink('https://veryhappy.dev/', '/session/abc')).toBe('https://veryhappy.dev/session/abc');
    expect(sessionLink('https://veryhappy.dev', 'terminal/m?tid=1')).toBe('https://veryhappy.dev/terminal/m?tid=1');
  });
});

describe('one builder for both surfaces', () => {
  const sidebar = readFileSync(new URL('../screens/sessions/Sidebar.tsx', import.meta.url), 'utf8');
  const header = readFileSync(new URL('../screens/session/ChatHeader.tsx', import.meta.url), 'utf8');
  it('the sidebar row and the session header both build from buildSessionMenu behind sessionMenuAvailability', () => {
    for (const src of [sidebar, header]) {
      expect(src).toMatch(/buildSessionMenu\(\{/);
      expect(src).toMatch(/sessionMenuAvailability\(/);
      expect(src).toContain('onShare: avail');
      expect(src).toContain('stopSessionTurn(');
      expect(src).toContain('copySessionLink(');
    }
    // 分享… is gated by the shared availability on both surfaces
    expect(sidebar).toContain('onShare: avail?.share ? onShare : undefined,');
    expect(header).toContain('onShare: avail.share ? () => setShareOpen(true) : undefined,');
    // no surface keeps a private share / project item list next to the builder
    expect(header).not.toContain("key:'share'");
    expect(header).not.toContain("key: 'move-project'");
    expect(sidebar).not.toContain('function rowMenuItems');
  });
  it('the row menu feeds both its ⋯ dropdown and its right-click / long-press menu', () => {
    expect(sidebar).toContain('<ActionContextMenu items={menuItems} sheetTitle={sheetTitle}>');
    expect(sidebar).toContain('<ActionDropdownMenu items={menuItems} align="end" sideOffset={4} sheetTitle={sheetTitle}>');
  });
  it('B-798: the header ⋯ is a titled sheet on phones and groups its tools before stop / archive', () => {
    // B-798 F: a phone-width header's 「会话信息」 sits between the panel toggles and the session actions
    expect(header).toContain('<ActionDropdownMenu sheetTitle={title} items={[...plan.overflow.map(menuItem), ...infoItems, ...withSessionTools(sessionItems, [');
    expect(header).toMatch(/key:'runtime-controls'[^\n]*key:'keep-awake'[^\n]*key:'team-adopt'/);
    // the project group ⋯ heads its sheet like its long-press menu
    expect(sidebar).toContain('<ActionDropdownMenu items={projectItems(project)} align="end" sideOffset={4} sheetTitle={project.name}>');
  });
});

describe('B-798 withSessionTools (session header ⋯ grouping)', () => {
  const tool = (key: string): MenuItemDef => ({ key, label: key, icon: (() => null) as unknown as MenuItemDef['icon'], onSelect: noop });
  const tools = [tool('runtime-controls'), tool('keep-awake'), tool('team-adopt')];
  it('puts the header tools in one group before the stop / archive tail', () => {
    const items = withSessionTools(buildSessionMenu(full()), tools);
    expect(items.map((i) => i.key)).toEqual(['share', 'rename', 'tags', 'move-project', 'leave-project', 'priority', 'copy-link', 'runtime-controls', 'keep-awake', 'team-adopt', 'stop', 'archive']);
    expect(items.filter((i) => i.separatorBefore).map((i) => i.key)).toEqual(['priority', 'runtime-controls', 'stop']);
  });
  it('without stop the archive starts its own group; without a tail the tools go last', () => {
    const noStop = withSessionTools(buildSessionMenu(full({ onStop: undefined })), tools);
    expect(noStop.slice(-4).map((i) => [i.key, !!i.separatorBefore])).toEqual([['runtime-controls', true], ['keep-awake', false], ['team-adopt', false], ['archive', true]]);
    const shared = withSessionTools(buildSessionMenu({ t, zh: false, onCopyLink: noop }), tools);
    expect(shared.map((i) => i.key)).toEqual(['copy-link', 'runtime-controls', 'keep-awake', 'team-adopt']);
    expect(withSessionTools([], tools)[0].separatorBefore).toBe(false);
    const base = buildSessionMenu(full());
    expect(withSessionTools(base, [])).toBe(base);
  });
});
