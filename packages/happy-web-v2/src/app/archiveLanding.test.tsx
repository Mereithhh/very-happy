// @vitest-environment happy-dom
/**
 * B-933 mechanism regression (incident B-932): ⌘W archived a session, the web
 * landed on the next one (B-111) and the landing page's B-587 open-wake
 * resumed it; the next ⌘W archived that session before the user had seen it.
 *
 * Real pieces: the ⌘W keydown handler (useCloseViewShortcuts), the confirm
 * flow + landing (rowActions), the auto-wake hook, the session store, the
 * router. Stubbed: the network (archive POST, restore spawn) and the dialog.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';

const net = vi.hoisted(() => ({ archived: [] as string[], restored: [] as string[] }));
vi.mock('@/sync/ops', async (orig) => ({
    ...(await orig<typeof import('@/sync/ops')>()),
    sessionArchive: async (id: string) => { net.archived.push(id); return { success: true }; },
}));
vi.mock('@/app/sessionRestore', async (orig) => ({
    ...(await orig<typeof import('@/app/sessionRestore')>()),
    restoreSession: async (id: string) => { net.restored.push(id); return true; },
}));

let storage: typeof import('@/sync/storage').storage;
let Modal: typeof import('@/modal').Modal;
let toast: typeof import('@/ui/Toast').toast;
let useCloseViewShortcuts: typeof import('./viewShortcuts').useCloseViewShortcuts;
let useHibernationAutoWake: typeof import('./useHibernationAutoWake').useHibernationAutoWake;
let resetWake: () => void;
let resetLanding: () => void;
let setProjectsDevOverride: typeof import('@/sync/projects').setProjectsDevOverride;

beforeAll(async () => {
    ({ storage } = await import('@/sync/storage'));
    ({ Modal } = await import('@/modal'));
    ({ toast } = await import('@/ui/Toast'));
    ({ useCloseViewShortcuts } = await import('./viewShortcuts'));
    const wake = await import('./useHibernationAutoWake');
    useHibernationAutoWake = wake.useHibernationAutoWake;
    resetWake = wake.resetHibernationAutoWakeForTest;
    resetLanding = (await import('./closeLanding')).resetCloseLandingForTest;
    ({ setProjectsDevOverride } = await import('@/sync/projects'));
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.now();
const stamp = { at: NOW - 60_000, seq: 1, idleMs: 3_600_000, v: 1 };
function session(id: string, title: string, over: Partial<Session> = {}): Session {
    return {
        id, seq: 1, createdAt: 1, updatedAt: NOW - 60_000, active: true, activeAt: NOW - 70_000, presence: 'online', thinking: false,
        metadataVersion: 1, agentState: null, agentStateVersion: 0,
        metadata: { path: '/repo', host: 'h', machineId: 'm1', flavor: 'claude', summary: { text: title, updatedAt: 1 } },
        ...over,
    } as unknown as Session;
}
/** The daily report: hibernated, but this tab still holds a stale `active` (the server's offline flip lands later). */
const dailyStale = () => session(DAILY, '每日健康日报', { activeAt: NOW - 70_000, metadata: { path: '/repo', host: 'h', machineId: 'm1', flavor: 'claude', summary: { text: '每日健康日报', updatedAt: 1 }, hibernation: stamp } as never });

function Screen() {
    const { id } = useParams();
    useHibernationAutoWake(id);
    return <div data-testid="screen">{id}</div>;
}
function App() {
    useCloseViewShortcuts();
    return <Routes><Route path="/session/:id" element={<Screen />} /><Route path="*" element={<div />} /></Routes>;
}

let host: HTMLDivElement;
let root: Root;
let confirms: (string | undefined)[];
let clockOffset = 0;
// Fresh ids per test: the archive hold (sessionArchiveHold) is module state and outlives a test.
let run = 0;
let CHAT = '';
let DAILY = '';
/** Let the open screen settle (> CLOSE_VIEW_SETTLE_MS since it appeared). */
const wait = (ms: number) => { clockOffset += ms; };
let toasts: string[];

async function flush() { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); }
async function cmdW() {
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', metaKey: true, bubbles: true, cancelable: true })); });
    await flush();
}
const shown = () => host.querySelector('[data-testid="screen"]')?.textContent ?? null;

beforeEach(() => {
    net.archived = []; net.restored = []; confirms = []; toasts = []; clockOffset = 0;
    run += 1; CHAT = `chat${run}`; DAILY = `daily${run}`;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
    resetWake(); resetLanding();
    setProjectsDevOverride({ status: 'ready', projects: [], members: [] });
    vi.spyOn(Modal, 'confirm').mockImplementation(async (_title: string, message?: string) => { confirms.push(message); return true; });
    vi.spyOn(toast, 'show').mockImplementation((message: string) => { toasts.push(message); });
    storage.setState((state) => ({ ...state, sessions: {}, machines: { m1: { id: 'm1', active: true } as never } }));
    storage.getState().applySessions([session(CHAT, '【周会】迁移确认'), dailyStale()]);
    window.history.replaceState(null, '', `/session/${CHAT}`);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<BrowserRouter><App /></BrowserRouter>));
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

/** The server's "it's offline (hibernated)" update reaching this tab. */
function dailyGoesOffline() {
    act(() => storage.getState().applySessions([{ ...storage.getState().sessions[DAILY], active: false } as Session]));
}

describe('B-933 archive landing does not wake the next session', () => {
    it('⌘W archive lands on the next session and only SHOWS it — no resume, even once it reads hibernated', async () => {
        wait(1_500);
        await cmdW();
        expect(net.archived).toEqual([CHAT]);
        expect(shown()).toBe(DAILY);
        dailyGoesOffline();
        await flush();
        expect(net.restored).toEqual([]);
    });

    it('control: opening the same hibernated session yourself still wakes it (B-587 unchanged)', async () => {
        dailyGoesOffline();
        act(() => root.unmount());
        resetWake(); resetLanding();
        window.history.replaceState(null, '', `/session/${DAILY}`);
        root = createRoot(host);
        act(() => root.render(<BrowserRouter><App /></BrowserRouter>));
        await flush();
        expect(net.restored).toEqual([DAILY]);
    });
});

describe('B-933 repeated ⌘W never archives a session the user has not seen', () => {
    it('the confirm names the session it will archive', async () => {
        wait(1_500);
        await cmdW();
        expect(confirms).toEqual(['Archiving: “【周会】迁移确认”']);
    });

    it('a ⌘W right after the landing only says where you are; the next one asks about THAT session', async () => {
        wait(1_500);
        await cmdW(); // archives "chat", lands on "daily"
        expect(shown()).toBe(DAILY);
        await cmdW(); // < 1 s after the landing
        expect(net.archived).toEqual([CHAT]);
        expect(confirms).toHaveLength(1);
        expect(toasts).toEqual(['Now on “每日健康日报” — press again to archive it']);
        await cmdW(); // deliberate second press
        expect(confirms.at(-1)).toBe('Archiving: “每日健康日报”');
        expect(net.archived).toEqual([CHAT, DAILY]);
    });

    it('a target that has been on screen for a second archives on the first ⌘W', async () => {
        wait(1_500);
        await cmdW();
        expect(toasts).toEqual([]);
        expect(net.archived).toEqual([CHAT]);
        wait(1_500); // the landed session has now been on screen > 1 s
        await cmdW();
        expect(toasts).toEqual([]);
        expect(net.archived).toEqual([CHAT, DAILY]);
    });

    it('a freshly shown session (any route change < 1 s ago) is not archived by the first ⌘W', async () => {
        await cmdW();
        expect(net.archived).toEqual([]);
        expect(confirms).toEqual([]);
        expect(toasts).toEqual(['Now on “【周会】迁移确认” — press again to archive it']);
    });
});
