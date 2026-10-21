// @vitest-environment happy-dom
/**
 * B-713: the sidebar's 新建团队 navigates to /teams?new=1, which must open the
 * create dialog directly (not the list), and the same click must open it again
 * after the dialog was closed (closing drops ?new=1, so the URL changes again).
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { expect, it, vi } from 'vitest';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/sync/teams', () => ({
  listTeams: vi.fn(async () => ({ teams: [] })),
  getTeam: vi.fn(),
  actOnTeam: vi.fn(),
  createTeam: vi.fn(),
  TeamsApiError: class extends Error { status = 500; },
}));
vi.mock('@/sync/storage', () => ({
  storage: (select: (s: unknown) => unknown) => select({ isDataReady: false, sessions: {} }),
  useAllMachines: () => [],
}));
vi.mock('@/sync/sync', () => ({ sync: { onResume: () => () => {} } }));
vi.mock('@/app/overlayQueue', () => ({ OVERLAY_PRIORITY: { interaction: 1 }, useOverlayTurn: () => true }));
vi.mock('@/screens/sessions/useTeamNavigation', () => ({ refreshTeamNavigation: () => {} }));
vi.mock('@/screens/session/Markdown', () => ({ Markdown: () => null }));
vi.mock('./TeamStartForm', () => ({ TeamStartForm: () => <form data-start-form /> }));
vi.mock('./TeamWorkspace', () => ({ TeamWorkspace: () => null, TeamListCard: () => null }));
vi.mock('./TeamSchedules', () => ({ TeamSchedules: () => null }));
vi.mock('./TeamOptions', () => ({ TeamOptions: () => null }));
vi.mock('./TeamTaskDetail', () => ({ TeamTaskMessages: () => null, TeamTaskSummary: () => null }));
vi.mock('./AdoptTeamForm', () => ({ AdoptTeamForm: () => null }));

const { TeamsScreen } = await import('./TeamsScreen');
const { NEW_TEAM_PATH } = await import('@/screens/sessions/sidebarNavEntries');

let go: (to: string) => void = () => {};
let where = '';
function Probe() {
  const navigate = useNavigate();
  const location = useLocation();
  go = navigate;
  where = location.pathname + location.search;
  return null;
}

it('新建团队 (/teams?new=1) opens the create dialog; closing it and clicking again reopens it', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const proto = HTMLDialogElement.prototype as unknown as { showModal?: () => void };
  if (!proto.showModal) proto.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/']}>
        <Probe />
        <Routes><Route path="/teams" element={<TeamsScreen />} /><Route path="/" element={null} /></Routes>
      </MemoryRouter>,
    ));
    await act(async () => go(NEW_TEAM_PATH));
    expect(host.querySelector('dialog.teams-dialog [data-start-form]')).not.toBeNull();

    // close (✕) → dialog gone and ?new=1 dropped
    await act(async () => host.querySelector<HTMLButtonElement>('.teams-dialog-heading button')!.click());
    expect(host.querySelector('[data-start-form]')).toBeNull();
    expect(where).toBe('/teams');

    // the sidebar button navigates to the same path again → the dialog is back
    await act(async () => go(NEW_TEAM_PATH));
    expect(host.querySelector('dialog.teams-dialog [data-start-form]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
