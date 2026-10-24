// @vitest-environment happy-dom
/**
 * B-798 G: a missing team says so instead of "teams are not enabled" (P2-5),
 * and archiving a team goes through the standard confirm (P2-7).
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => {
  class TeamsApiError extends Error { constructor(public status: number, public code: string) { super(code); } }
  return { TeamsApiError, getTeam: vi.fn(), actOnTeam: vi.fn(), confirm: vi.fn() };
});
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/sync/teams', () => ({
  listTeams: vi.fn(async () => ({ teams: [] })),
  getTeam: api.getTeam,
  actOnTeam: api.actOnTeam,
  createTeam: vi.fn(),
  TeamsApiError: api.TeamsApiError,
}));
vi.mock('@/modal', () => ({ Modal: { confirm: api.confirm } }));
vi.mock('@/sync/storage', () => ({
  storage: (select: (s: unknown) => unknown) => select({ isDataReady: false, sessions: {} }),
  useAllMachines: () => [],
}));
vi.mock('@/sync/sync', () => ({ sync: { onResume: () => () => {} } }));
vi.mock('@/app/overlayQueue', () => ({ OVERLAY_PRIORITY: { interaction: 1 }, useOverlayTurn: () => true }));
vi.mock('@/screens/sessions/useTeamNavigation', () => ({ refreshTeamNavigation: () => {} }));
vi.mock('@/screens/session/Markdown', () => ({ Markdown: () => null }));
vi.mock('./TeamStartForm', () => ({ TeamStartForm: () => null }));
vi.mock('./TeamWorkspace', () => ({ TeamWorkspace: () => null, TeamListCard: () => null }));
vi.mock('./TeamSchedules', () => ({ TeamSchedules: () => null }));
vi.mock('./TeamOptions', () => ({ TeamOptions: () => null }));
vi.mock('./TeamTaskDetail', () => ({ TeamTaskMessages: () => null, TeamTaskSummary: () => null }));
vi.mock('./AdoptTeamForm', () => ({ AdoptTeamForm: () => null }));

const { TeamsScreen } = await import('./TeamsScreen');
const { FIRST_USE_COPY } = await import('./firstUseCopy');
const { t: tr } = await import('@/text');

const TEAM = { id: 't1', name: 'Atlas', machineId: 'm1', version: 1, createdAt: 1, bots: [], tasks: [], operations: [], messages: [] };
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  api.getTeam.mockReset(); api.actOnTeam.mockReset(); api.confirm.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function open(id: string) {
  await act(async () => root.render(
    <MemoryRouter initialEntries={[`/teams/${id}`]}><Routes><Route path="/teams/:teamId" element={<TeamsScreen />} /></Routes></MemoryRouter>,
  ));
  await act(async () => { await Promise.resolve(); });
}

it('404 team_not_found → "this team does not exist" with a link to all teams, not "unavailable"', async () => {
  api.getTeam.mockRejectedValue(new api.TeamsApiError(404, 'team_not_found'));
  await open('gone');
  expect(host.textContent).toContain(FIRST_USE_COPY.en.notFound);
  expect(host.textContent).not.toContain(FIRST_USE_COPY.en.unavailable);
  expect(host.querySelector('a[href="/teams"]')?.textContent).toContain(FIRST_USE_COPY.en.allTeams);
});

it('404 teams_disabled still explains the feature is unavailable', async () => {
  api.getTeam.mockRejectedValue(new api.TeamsApiError(404, 'teams_disabled'));
  await open('t1');
  expect(host.textContent).toContain(FIRST_USE_COPY.en.unavailable);
  expect(host.textContent).not.toContain(FIRST_USE_COPY.en.notFound);
});

it('归档团队 asks through the standard destructive confirm; cancel does nothing, confirm archives', async () => {
  api.getTeam.mockResolvedValue({ team: TEAM });
  api.actOnTeam.mockResolvedValue({ team: { ...TEAM, archivedAt: 2 } });
  await open('t1');
  const archive = host.querySelector<HTMLButtonElement>('.teams-heading-actions button:has(svg.lucide-archive)')!;
  api.confirm.mockResolvedValueOnce(false);
  await act(async () => archive.click());
  expect(api.confirm).toHaveBeenCalledWith(tr('teams.archive'), tr('teams.archiveDescription'), expect.objectContaining({ confirmText: tr('teams.archive'), destructive: true }));
  expect(api.actOnTeam).not.toHaveBeenCalled();
  expect(host.querySelector('dialog')).toBeNull();
  api.confirm.mockResolvedValueOnce(true);
  await act(async () => archive.click());
  expect(api.actOnTeam).toHaveBeenCalledWith('t1', { type: 'archive' }, expect.any(String));
});
