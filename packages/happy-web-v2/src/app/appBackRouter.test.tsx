// @vitest-environment happy-dom
/**
 * B-798 P0-2: opening a deep link (push, share link, PWA cold start) and then
 * pressing back repeatedly ping-ponged child ↔ parent forever — the parent
 * fallback PUSHed, the depth became 1, and the parent's back popped into the
 * deep link again. Drives the real hooks in a real (memory) router.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { __setNavDepth, setPinnedSidebar, useAppBack, useGlobalBackNav } from './appBack';

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

let goBack: () => boolean = () => false;

function Screen() {
  useGlobalBackNav();
  goBack = useAppBack().goBack;
  return null;
}

function openDeepLink(path: string) {
  __setNavDepth(0); // fresh document
  const router = createMemoryRouter([{ path: '*', element: <Screen /> }], { initialEntries: [path] });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<RouterProvider router={router} />));
  return router;
}

async function pressBack(times: number, router: ReturnType<typeof openDeepLink>): Promise<string[]> {
  const seen = [router.state.location.pathname];
  for (let i = 0; i < times; i++) {
    let handled = false;
    await act(async () => {
      handled = goBack();
    });
    if (!handled) break;
    seen.push(router.state.location.pathname);
  }
  return seen;
}

it.each([
  ['/settings/account', ['/settings/account', '/settings', '/']],
  ['/teams/demo', ['/teams/demo', '/teams', '/']],
  ['/projects/p1/settings', ['/projects/p1/settings', '/projects/p1', '/projects', '/']],
])('deep link %s: repeated back reaches / and stops', async (link, expected) => {
  const router = openDeepLink(link);
  expect(await pressBack(8, router)).toEqual(expected);
});

it('in-app history still wins: push then back returns to the previous page, not the IA parent', async () => {
  const router = openDeepLink('/session/a');
  await act(async () => {
    await router.navigate('/settings/account');
  });
  expect(await pressBack(1, router)).toEqual(['/settings/account', '/session/a']);
});

// ---------------------------------------------------------------------------
// B-946: no sidebar (phone) → back goes to the list, and the system back button
// cannot walk into the conversation again
// ---------------------------------------------------------------------------

it('no sidebar: list → chat A → chat B → back returns to the LIST, and a further system back stays there', async () => {
  setPinnedSidebar(false);
  const router = openDeepLink('/');
  await act(async () => { await router.navigate('/session/a'); });
  await act(async () => { await router.navigate('/session/b'); });
  expect(await pressBack(1, router)).toEqual(['/session/b', '/']);
  // the chat entries are BEHIND us now — the system/browser back has nothing
  // of ours to return to (one more in-app back is a no-op at the root)
  expect(await pressBack(1, router)).toEqual(['/']);
  await act(async () => { await router.navigate(-1); });
  expect(router.state.location.pathname).toBe('/');
});

it('no sidebar: a chat opened from /board returns to /board', async () => {
  setPinnedSidebar(false);
  const router = openDeepLink('/board');
  await act(async () => { await router.navigate('/session/a'); });
  await act(async () => { await router.navigate('/session/b'); });
  expect(await pressBack(1, router)).toEqual(['/session/b', '/board']);
});

it('no sidebar: deep-linked chat (cold start, empty stack) goes to the list by replacing', async () => {
  setPinnedSidebar(false);
  const router = openDeepLink('/session/a');
  expect(await pressBack(1, router)).toEqual(['/session/a', '/']);
  // replacing keeps the stack empty: pressing again does nothing
  expect(await pressBack(1, router)).toEqual(['/']);
});

it('sidebar on screen (desktop): history still wins — back returns to the previous chat', async () => {
  setPinnedSidebar(true);
  const router = openDeepLink('/');
  await act(async () => { await router.navigate('/session/a'); });
  await act(async () => { await router.navigate('/session/b'); });
  expect(await pressBack(1, router)).toEqual(['/session/b', '/session/a']);
});
