// @vitest-environment happy-dom
/**
 * B-756: a project entry in the tag lens's 「项目」 area behaves like a project
 * group head: the name opens the project, ＋ starts a session in it, ⚙ opens
 * its settings, right-click gives the project menu.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectView } from '@slopus/happy-wire';
import { buildProjectMenu } from '@/screens/projects/projectMenu';

const { SidebarProjectRow } = await import('./SidebarProjectRow');

const project = { id: 'p1', name: 'very-happy', goal: null, instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders: [], defaults: {}, archivedAt: null, createdAt: 1, updatedAt: 1, teamIds: [], automationIds: [] } as ProjectView;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(extra: { attention?: number; selected?: boolean } = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const h = { onOpen: vi.fn(), onNewSession: vi.fn(), onSettings: vi.fn(), menuNew: vi.fn(), menuSettings: vi.fn(), menuRename: vi.fn(), menuArchive: vi.fn() };
  const menuItems = buildProjectMenu({ zh: false, onNewSession: h.menuNew, onSettings: h.menuSettings, onRename: h.menuRename, onArchive: h.menuArchive });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<SidebarProjectRow entry={{ project, sessions: 3, attention: extra.attention ?? 0 }} selected={!!extra.selected} zh={false} attentionLabel="2 waiting" menuItems={menuItems} onOpen={h.onOpen} onNewSession={h.onNewSession} onSettings={h.onSettings} />));
  return { el: host, ...h };
}

describe('SidebarProjectRow (B-756)', () => {
  it('the name opens the project; ＋ and ⚙ do only their own action', async () => {
    const r = await render();
    await act(async () => r.el.querySelector<HTMLButtonElement>('.sb-project-main')!.click());
    expect(r.onOpen).toHaveBeenCalledTimes(1);
    const [plus, gear] = Array.from(r.el.querySelectorAll<HTMLButtonElement>('.sb-project-act'));
    expect(plus.getAttribute('aria-label')).toBe('New session: very-happy');
    expect(gear.getAttribute('aria-label')).toBe('Project settings: very-happy');
    await act(async () => plus.click());
    await act(async () => gear.click());
    expect([r.onNewSession.mock.calls.length, r.onSettings.mock.calls.length, r.onOpen.mock.calls.length]).toEqual([1, 1, 1]);
  });
  it('shows 等你处理 instead of the session count when something waits; selected on its page', async () => {
    const idle = await render();
    expect(idle.el.querySelector('.sb-project-count')!.textContent).toBe('3');
    await act(async () => root!.unmount()); root = null; host!.remove();
    const waiting = await render({ attention: 2, selected: true });
    expect(waiting.el.querySelector('.sb-section-attention')!.getAttribute('aria-label')).toBe('2 waiting');
    expect(waiting.el.querySelector('.sb-project-row')!.classList.contains('is-selected')).toBe(true);
    expect(waiting.el.querySelector('.sb-project-main')!.getAttribute('aria-current')).toBe('page');
  });
  it('right-click opens the project menu: new session / settings / rename / archive', async () => {
    const r = await render();
    await act(async () => { r.el.querySelector('.sb-project-row')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 })); });
    const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map((n) => n.textContent?.trim());
    expect(items).toEqual(['New session', 'Project settings', 'Rename', 'Archive project']);
  });
});
