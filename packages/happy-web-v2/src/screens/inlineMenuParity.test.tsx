// @vitest-environment happy-dom
/**
 * B-798 (U1/U3): a long-press menu is a shortcut, never the only way in. Board
 * cards and note rows each carry a visible ⋯ whose items are the long-press
 * menu's own; on touch the ACTIVE workspace tab does too (Lead 10-24: desktop
 * tabs stay label + ✕). Touch targets are 44px.
 */
import { readFileSync } from 'node:fs';
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Def = { key: string; label: string; disabled?: boolean };
const menus = vi.hoisted(() => ({ ctx: [] as Def[][], dd: [] as Def[][] }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@/ui', async () => {
  const React = await import('react');
  return {
    ActionContextMenu: ({ items, children }: { items: Def[]; children: ReactNode }) => { menus.ctx.push(items); return children; },
    ActionDropdownMenu: ({ items, children }: { items: Def[]; children: ReactElement }) => { menus.dd.push(items); return React.cloneElement(children, { 'data-dd': menus.dd.length - 1 } as never); },
    StatusDot: () => null,
    TagChip: () => null,
  };
});
vi.mock('@/ui/Menu', async () => await import('@/ui'));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ settings: {}, sessions: {} }) } }));
vi.mock('@/sync/sync', () => ({ sync: { applySettings: vi.fn() } }));
vi.mock('@/app/rowActions', () => ({ confirmArchiveSession: vi.fn(), confirmCloseTerminal: vi.fn(), markSessionDoneWithUndo: vi.fn() }));
vi.mock('./board/useBoardItems', () => ({ useSessionPreview: () => null }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn() } }));
vi.mock('@/screens/sessions/RenameModal', () => ({ RenameModal: () => null }));
vi.mock('@/sync/notesStore', () => ({
  useNotes: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ loaded: true, notes: {
      a: { id: 'a', content: 'alpha', createdAt: 1, updatedAt: 2 },
      b: { id: 'b', content: 'beta', createdAt: 1, updatedAt: 3 },
    } }),
    { getState: () => ({ updateMeta: vi.fn(), deleteNote: vi.fn() }) },
  ),
}));

import { BoardCard } from './board/BoardCard';
import type { BoardItem } from './board/boardItems';
import { NotesList } from './notes/NotesList';
import { WorkspaceTabsView } from './workspace/WorkspaceTabsView';

async function render(el: ReactElement) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const keys = (items: Def[]) => items.map((i) => `${i.key}:${i.disabled ? 'off' : 'on'}`);

afterEach(() => { menus.ctx.length = 0; menus.dd.length = 0; navigate.mockClear(); });

describe('B-798 visible ⋯ mirrors the long-press menu', () => {
  const item: BoardItem = {
    key: 's1', kind: 'session', status: 'idle', title: 'Fix it', machineName: 'm', cwd: '/w',
    lastActivityAt: 0, href: '/session/s1', lifecycle: 'waiting', waitReason: 'idle',
  } as BoardItem;

  it('board card: ⋯ opens the card menu itself, and tapping it never opens the card', async () => {
    const { host, unmount } = await render(<BoardCard item={item} now={0} onRenameRequest={vi.fn()} />);
    try {
      expect(menus.dd).toHaveLength(1);
      expect(menus.dd[0]).toBe(menus.ctx[0]);
      expect(keys(menus.dd[0])).toEqual(['done:on', 'open:on', 'move-top:on', 'rename:on', 'archive:on']);
      const more = host.querySelector<HTMLButtonElement>('.bd-card-more')!;
      expect(more.getAttribute('aria-label')).toBe('common.moreActions: Fix it');
      await act(async () => more.click());
      expect(navigate).not.toHaveBeenCalled();
    } finally { await unmount(); }
  });

  it('note rows: every row has a ⋯ with that row\'s own menu', async () => {
    const { host, unmount } = await render(<NotesList onOpen={vi.fn()} onPin={vi.fn()} />);
    try {
      expect(host.querySelectorAll('.notes-list-item .notes-list-more')).toHaveLength(2);
      expect(menus.dd).toHaveLength(2);
      menus.dd.forEach((items, i) => expect(items).toBe(menus.ctx[i]));
      expect(keys(menus.dd[0])).toEqual(['pin:on', 'rename:on', 'archive:on', 'delete:on']);
    } finally { await unmount(); }
  });

  it('workspace tabs: only the active tab carries a ⋯, with its long-press items', async () => {
    const tabs = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C', closable: false }];
    const { host, unmount } = await render(<WorkspaceTabsView zh={false} tabs={tabs} active="c" onSelect={vi.fn()} onClose={vi.fn()} onMove={vi.fn()} />);
    try {
      expect(host.querySelectorAll('.workspace-tab-more')).toHaveLength(1);
      const more = host.querySelector('.workspace-tab.is-active .workspace-tab-more')!;
      expect(more.getAttribute('aria-label')).toBe('Tab actions: C');
      const dd = menus.dd[Number(more.getAttribute('data-dd'))];
      expect(keys(dd)).toEqual(keys(menus.ctx[2]));
      expect(keys(dd)).toEqual(['close:off', 'others:on']);
    } finally { await unmount(); }
  });

  it('workspace tabs: no ⋯ when the active tab\'s menu could do nothing', async () => {
    const { host, unmount } = await render(<WorkspaceTabsView zh={false} tabs={[{ id: 'a', title: 'A', closable: false }]} active="a" onSelect={vi.fn()} onClose={vi.fn()} onMove={vi.fn()} />);
    try { expect(host.querySelector('.workspace-tab-more')).toBeNull(); } finally { await unmount(); }
  });
});

/** Top-level rules as [mediaPrelude | null, selector, body] in source order. */
function rules(file: string): Array<[string | null, string, string]> {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Array<[string | null, string, string]> = [];
  const walk = (text: string, media: string | null) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1; let j = open + 1;
      while (depth && j < text.length) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      const body = text.slice(open + 1, j - 1);
      if (prelude.startsWith('@media')) walk(body, prelude); else out.push([media, prelude, body]);
      i = j;
    }
  };
  walk(src, null);
  return out;
}
const selects = (sel: string, cls: string) => sel.split(',').some((s) => s.trim() === cls);
const coarse = (m: string | null) => !!m && /pointer:\s*coarse/.test(m);
const fineHover = (m: string | null) => !!m && /hover:\s*hover/.test(m) && /pointer:\s*fine/.test(m);

describe('B-798 touch targets and visibility', () => {
  it.each([
    ['./board/board.css', '.bd-card-done'],
    ['./board/board.css', '.bd-card-more'],
    ['./notes/notes.css', '.notes-list-more'],
    ['./workspace/workspaceTabs.css', '.workspace-tab-more'],
  ])('%s %s: 44×44 under pointer: coarse; hidden only on fine-pointer hover devices', (file, cls) => {
    const all = rules(file);
    const sized = all.filter(([m, sel, body]) => coarse(m) && selects(sel, cls) && /(^|;|\s)width:\s*44px/.test(body) && /(^|;|\s)(min-)?height:\s*44px/.test(body));
    expect(sized.length).toBeGreaterThan(0);
    const hides = all.filter(([, sel, body]) => selects(sel, cls) && /opacity:\s*0\s*(;|$)|display:\s*none/.test(body));
    for (const [m] of hides) expect(fineHover(m)).toBe(true);
  });

  it('workspace tab ⋯ is touch-only: fine-pointer hover devices hide it outright', () => {
    const off = rules('./workspace/workspaceTabs.css').filter(([m, sel, body]) => fineHover(m) && selects(sel, '.workspace-tab-more') && /display:\s*none/.test(body));
    expect(off.length).toBeGreaterThan(0);
  });
});
