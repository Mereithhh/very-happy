// @vitest-environment happy-dom
/**
 * B-567: auto-read needs a present human. A visible tab with nobody at it (no
 * focus or no recent trusted input) must not mark the open session read;
 * the first trusted input (a click, a key, a scroll, a tap) does.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ markSeen: vi.fn(), initialize: vi.fn(), refresh: vi.fn() }));
vi.mock('@/sync/notificationSeenStore', () => ({
    setSeenCredentials: vi.fn(),
    useNotificationSeen: { getState: () => seen },
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: null }) }));
vi.mock('@/sync/systemNotificationDismiss', () => ({ dismissSystemNotificationsFor: vi.fn(async () => {}) }));

import { DWELL_MS, HEARTBEAT_MS, useSeenTracker } from './useSeenTracker';
import { notePresenceInput, resetPresenceForTest } from '@/sync/userPresence';
import { stampSeenOnArrival } from '@/sync/seenOnArrival';

function Probe() { useSeenTracker(); return null; }

describe('useSeenTracker presence gate (B-567)', () => {
    let host: HTMLDivElement; let root: Root; let focused = true;
    beforeEach(() => {
        vi.useFakeTimers();
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
        resetPresenceForTest();
        seen.markSeen.mockClear();
        focused = true;
        vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
        host = document.createElement('div'); document.body.append(host);
        root = createRoot(host);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });
    const mount = () => act(async () => root.render(<MemoryRouter initialEntries={['/session/s1']}><Probe /></MemoryRouter>));
    const input = () => act(async () => notePresenceInput({ isTrusted: true }, Date.now()));

    it('visible + focused but no input yet: not read; the first input reads it after the dwell', async () => {
        await mount();
        await act(async () => { vi.advanceTimersByTime(DWELL_MS * 3); });
        expect(seen.markSeen).not.toHaveBeenCalled();
        await input();
        await act(async () => { vi.advanceTimersByTime(DWELL_MS); });
        expect(seen.markSeen).toHaveBeenCalledWith(['s1']);
    });

    it('mobile: the tap that opened the session counts — read after the dwell (no regression)', async () => {
        await input(); // touchstart/pointerdown on the sidebar row
        await mount();
        await act(async () => { vi.advanceTimersByTime(DWELL_MS); });
        expect(seen.markSeen).toHaveBeenCalledWith(['s1']);
    });

    it('window not focused (another app in front): not read even with recent input', async () => {
        await input();
        focused = false;
        await mount();
        await act(async () => { vi.advanceTimersByTime(DWELL_MS * 3); });
        expect(seen.markSeen).not.toHaveBeenCalled();
    });

    it('heartbeats stop when the user walks away and resume on the next input', async () => {
        await input();
        await mount();
        await act(async () => { vi.advanceTimersByTime(DWELL_MS); });
        expect(seen.markSeen).toHaveBeenCalledTimes(1);
        // 6 minutes, no input: the 5-minute window lapses
        await act(async () => { vi.advanceTimersByTime(HEARTBEAT_MS * 6); });
        const afterAway = seen.markSeen.mock.calls.length;
        await act(async () => { vi.advanceTimersByTime(HEARTBEAT_MS * 3); });
        expect(seen.markSeen.mock.calls.length).toBe(afterAway); // away: no stamps
        await input(); // back: missed heartbeat made up immediately
        expect(seen.markSeen.mock.calls.length).toBe(afterAway + 1);
    });

    it('arrival on the self-view stamps only when present', async () => {
        window.history.replaceState({}, '', '/session/s1');
        stampSeenOnArrival('s1', '/session/s1', Date.now());
        expect(seen.markSeen).not.toHaveBeenCalled(); // visible, but no input ever
        notePresenceInput({ isTrusted: true }, Date.now());
        stampSeenOnArrival('s1', '/session/s1', Date.now());
        expect(seen.markSeen).toHaveBeenCalledTimes(1);
        focused = false;
        stampSeenOnArrival('s1', '/session/s1', Date.now());
        expect(seen.markSeen).toHaveBeenCalledTimes(1);
    });
});
