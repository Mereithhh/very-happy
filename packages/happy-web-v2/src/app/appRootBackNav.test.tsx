// @vitest-environment happy-dom
/**
 * B-946b: the phone back from a chat opened on the home list `/` REPLACED
 * instead of popping, so a further browser/system back walked into the
 * previous chat. Root cause was route-level, not in the pure resolver: `/`
 * (RootGate) and `/session/:id` (RequireAuth) each mounted their own
 * useGlobalBackNav(), the tracker remounted on `/` → `/session` and reset the
 * trail. This drives the REAL AppRoot route tree (`appRoutes`) in a memory
 * router — only the leaf screens and the notice/banner chrome are stubbed, the
 * gates, the layout nesting and the back hooks are the production ones.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true }),
  AuthProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('@/screens/AppLayout', () => ({ AppLayout: () => <Outlet /> }));
vi.mock('./CliUpdateBanner', () => ({ CliUpdateBanner: () => null }));
vi.mock('./MigrationBanner', () => ({ MigrationBanner: () => null }));
vi.mock('@/app/UpdatePrompt', () => ({ UpdatePrompt: () => null }));
vi.mock('./AuthExpiredNotice', () => ({ AuthExpiredNotice: () => null }));
vi.mock('./afterFirstScreen', () => ({ useAfterFirstScreen: () => false }));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), useToast: () => ({ success() {} }) }));
vi.mock('@/sync/storage', async (orig) => ({
  ...(await orig<object>()),
  useIsDataReady: () => true,
  useAllMachines: () => [{ id: 'm' }],
  useSessions: () => [{ id: 'a' }, { id: 'b' }],
  useLocalSetting: () => 'list',
}));
vi.mock('@/screens/sessions/EmptyDetail', () => ({ EmptyDetail: () => <div data-screen="home" /> }));
vi.mock('@/screens/session/SessionDetailScreen', () => ({ SessionDetailScreen: () => <div data-screen="session" /> }));
vi.mock('@/screens/board/TaskBoardScreen', () => ({ TaskBoardScreen: () => <div data-screen="board" /> }));
vi.mock('@/screens/teams/TeamsScreen', () => ({ TeamsScreen: () => <div data-screen="teams" /> }));

const { appRoutes } = await import('./AppRoot');
const { __setNavDepth, setPinnedSidebar, useAppBack } = await import('./appBack');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  __setNavDepth(0);
  setPinnedSidebar(true);
  sessionStorage.clear();
});

/** A probe that is NOT a back tracker: it only reads the shared `goBack`. */
let goBack: () => boolean = () => false;
function Probe() {
  goBack = useAppBack().goBack;
  return null;
}

function open(path: string) {
  __setNavDepth(0); // fresh document
  const router = createMemoryRouter(
    [{ element: <><Probe /><Outlet /></>, children: appRoutes }],
    { initialEntries: [path] },
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<RouterProvider router={router} />));
  return router;
}

type R = ReturnType<typeof open>;

async function go(router: R, to: string | number) {
  await act(async () => { await router.navigate(to as string); });
  // lazy routes resolve on a microtask; let them settle
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function appBack(router: R) {
  let handled = false;
  await act(async () => { handled = goBack(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return handled ? router.state.location.pathname : null;
}

it.each([
  ['/', '/'],
  ['/board', '/board'],
  ['/teams/t1', '/teams/t1'],
])('phone: %s → chat A → chat B → back lands on the list, and a further browser back leaves no chat behind', async (start, list) => {
  setPinnedSidebar(false);
  const router = open(start);
  await go(router, '/session/a');
  await go(router, '/session/b');
  expect(await appBack(router)).toBe(list);
  // B-946b: a POP to the list (historyAction POP, not REPLACE) — the chats are
  // ahead of us in the stack, so nothing of ours is behind the list.
  expect(router.state.historyAction).toBe('POP');
  await go(router, -1);
  expect(router.state.location.pathname).toBe(list);
});

it('phone: single hop / → chat → back pops (no duplicate list entry)', async () => {
  setPinnedSidebar(false);
  const router = open('/');
  await go(router, '/session/a');
  expect(await appBack(router)).toBe('/');
  expect(router.state.historyAction).toBe('POP');
});

it('desktop (sidebar on screen): / → chat A → chat B → back returns to chat A', async () => {
  setPinnedSidebar(true);
  const router = open('/');
  await go(router, '/session/a');
  await go(router, '/session/b');
  expect(await appBack(router)).toBe('/session/a');
  expect(router.state.historyAction).toBe('POP');
});
