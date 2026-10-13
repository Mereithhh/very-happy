// @vitest-environment happy-dom
/**
 * B-567 review #2/#3: presence must be tracked from boot.
 *  - cold start on a phone: the tap on the first sidebar row happens BEFORE
 *    the session route (and its tracker) mounts — it must still count;
 *  - push click: the SW's `vh_presence=1` marker counts as one input and is
 *    stripped from the URL.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const seen = vi.hoisted(() => ({ markSeen: vi.fn(), initialize: vi.fn(), refresh: vi.fn() }));
vi.mock('@/sync/notificationSeenStore', () => ({ setSeenCredentials: vi.fn(), useNotificationSeen: { getState: () => seen } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: null }) }));
vi.mock('@/sync/systemNotificationDismiss', () => ({ dismissSystemNotificationsFor: vi.fn(async () => {}) }));

import { resetPresenceForTest, readPresence } from '@/sync/userPresence';
import { DWELL_MS, useSeenTracker } from './useSeenTracker';
import { bootPresence, stripPresenceMarker } from './presenceBoot';

function Probe() { useSeenTracker(); return null; }
function trusted(type: string): Event {
    const e = new Event(type, { bubbles: true });
    Object.defineProperty(e, 'isTrusted', { value: true }); // a real finger, as far as the listener can tell
    return e;
}

describe('stripPresenceMarker', () => {
    it('detects and removes only the marker', () => {
        expect(stripPresenceMarker('?vh_presence=1')).toEqual({ marked: true, search: '' });
        expect(stripPresenceMarker('?tid=t9&vh_presence=1')).toEqual({ marked: true, search: '?tid=t9' });
        expect(stripPresenceMarker('?tid=t9')).toEqual({ marked: false, search: '?tid=t9' });
        expect(stripPresenceMarker('')).toEqual({ marked: false, search: '' });
    });
});

describe('boot-time presence', () => {
    let host: HTMLDivElement; let root: Root;
    beforeEach(() => {
        vi.useFakeTimers();
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
        resetPresenceForTest();
        seen.markSeen.mockClear();
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        host = document.createElement('div'); document.body.append(host);
        root = createRoot(host);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });
    const mountAt = (path: string) => act(async () => root.render(<MemoryRouter initialEntries={[path]}><Probe /></MemoryRouter>));

    it('cold start: touch on the home list FIRST, then the session page mounts → read after the dwell', async () => {
        window.history.replaceState({}, '', '/');
        bootPresence(window); // main.tsx side effect
        window.dispatchEvent(trusted('touchstart')); // tap on the sidebar row, tracker not mounted yet
        expect(readPresence().lastInputAt).not.toBeNull();
        await mountAt('/session/s1');
        await act(async () => { vi.advanceTimersByTime(DWELL_MS); });
        expect(seen.markSeen).toHaveBeenCalledWith(['s1']);
    });

    it('push click marker: counts as presence with no in-page input, and is stripped from the URL', async () => {
        window.history.replaceState({ keep: 1 }, '', '/terminal/m1?tid=t9&vh_presence=1#x');
        bootPresence(window);
        expect(window.location.pathname + window.location.search + window.location.hash).toBe('/terminal/m1?tid=t9#x');
        expect(window.history.state).toEqual({ keep: 1 });
        await mountAt('/terminal/m1?tid=t9');
        await act(async () => { vi.advanceTimersByTime(DWELL_MS); });
        expect(seen.markSeen).toHaveBeenCalledWith(['t:t9']);
    });

    it('no marker, no input: still not read (presence unknown)', async () => {
        window.history.replaceState({}, '', '/session/s2');
        bootPresence(window);
        await mountAt('/session/s2');
        await act(async () => { vi.advanceTimersByTime(DWELL_MS * 3); });
        expect(seen.markSeen).not.toHaveBeenCalled();
    });

    it('main.tsx installs it at boot, before the app root', () => {
        const main = readFileSync(resolve(__dirname, '../main.tsx'), 'utf8')
            .replace(/\/\/.*$/gm, '');
        expect(main).toMatch(/^import '\.\/app\/presenceBoot';$/m);
        expect(main.indexOf("import './app/presenceBoot';")).toBeLessThan(main.indexOf('AppRoot'));
    });
});
