// @vitest-environment happy-dom
/**
 * B-639: an unknown path (an agent's file link opened as a page) reached the
 * route errorElement and was told "check your network connection". Real
 * router, real RouteError: a 404 says "not found", a render bug does not
 * blame the network, and a chunk failure still does.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./staleBundleReload', () => ({ recoverChunkLoad: vi.fn(async () => 'unavailable') }));
vi.mock('./prepaintSplash', () => ({ dismissPrepaintSplash: () => {} }));
vi.mock('@/i18n/localeCore', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/i18n/localeCore')>()), readStoredPreferredLanguage: () => 'en' }));

import { RouteError } from './RouteError';
import { routeFailureKind } from './chunkRecovery';

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

async function renderAt(path: string, Element: () => React.ReactNode = () => 'home') {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const router = createMemoryRouter([{ errorElement: <RouteError />, children: [{ path: '/', element: <Element /> }, { path: '/session/:id', element: <Element /> }] }], { initialEntries: [path] });
    await act(async () => root.render(<RouterProvider router={router} />));
    cleanup = () => { root.unmount(); host.remove(); };
    return host.textContent ?? '';
}

describe('route error page (B-639)', () => {
    it('an agent file link opened as a page is "not found", not a network problem', async () => {
        const text = await renderAt('/Users/me/web_v23_2_encoding_spans_20261020.jsonnet');
        expect(text).toContain('Page not found');
        expect(text).not.toContain('connection');
    });

    it('a render bug does not blame the network', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const text = await renderAt('/', () => { throw new Error('Cannot read properties of undefined'); });
        expect(text).toContain('Something went wrong');
        expect(text).not.toContain('connection');
    });

    it('a chunk failure is still a connection/deploy problem', () => {
        expect(routeFailureKind(new TypeError('Failed to fetch dynamically imported module: /assets/a.js'))).toBe('chunk');
        expect(routeFailureKind({ status: 404 })).toBe('not-found');
        expect(routeFailureKind(new Error('x'))).toBe('error');
    });
});
