// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ session: null as any, machine: null as any, restore: undefined as any, restoreSession: vi.fn() }));
vi.mock('@/sync/storage', () => ({
    useSession: () => mock.session,
    storage: (selector: any) => selector({ machines: mock.machine ? { m1: mock.machine } : {} }),
}));
vi.mock('@/app/sessionRestore', () => ({
    isNeverRunOffline: () => false,
    restoreSession: mock.restoreSession,
    useRestoreState: () => mock.restore,
    RESTORE_SLOW_SPAWN_MS: 10_000,
}));
vi.mock('@/app/sessionHibernation', () => ({ isHibernated: () => false }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string, p?: Record<string, string>) => (p ? `${key}:${JSON.stringify(p)}` : key) }) }));
import { SessionArchivedBanner } from './SessionArchivedBanner';

let host: HTMLDivElement, root: Root;
const render = () => act(() => root.render(<SessionArchivedBanner sessionId="s1" />));
const offlineFailure = (status: Record<string, unknown>) => {
    const now = Date.now();
    mock.machine.daemonState = { startedAt: now - 60_000, autoRestart: { enabled: true, rpcAvailable: true, detectedAt: now, sessions: { s1: { state: 'failed', since: now, target: '0.2.192', ...status } } } };
};

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mock.session = { archivedAt: null, active: false, metadata: { machineId: 'm1' } };
    mock.machine = { active: true, daemonState: {} };
    mock.restore = undefined;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('a plain offline session keeps the generic notice', () => {
    render();
    expect(host.textContent).toContain('restore.offlineNotice');
});

// QA25 P2-2: the automatic update stopped the old wrapper and the new one never came up.
it('an offline automatic-update failure says why and when it retries; Restore stays', () => {
    offlineFailure({ reason: 'Agent process exited during startup (code 1)', offline: true, retryAt: Date.now() + 600_000 });
    render();
    expect(host.textContent).toContain('autoRestart.offlineFailedRetry');
    expect(host.textContent).toContain('Agent process exited during startup (code 1)');
    expect(host.querySelector('[data-auto-restart-failed]')).not.toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('.mrb-term-btn')!.click());
    expect(mock.restoreSession).toHaveBeenCalledExactlyOnceWith('s1');
});

it('after the last try it is left to Restore', () => {
    offlineFailure({ reason: 'boom', offline: true });
    render();
    expect(host.textContent).toContain('autoRestart.offlineFailed:');
});

it('a live-session failure or an archived session does not use the offline wording', () => {
    offlineFailure({ reason: 'boom' });
    render();
    expect(host.textContent).toContain('restore.offlineNotice');
    offlineFailure({ reason: 'boom', offline: true });
    mock.session.archivedAt = 1;
    render();
    expect(host.textContent).toContain('restore.archivedNotice');
});

it('a Restore in progress narrates the restore, not the failure', () => {
    offlineFailure({ reason: 'boom', offline: true });
    mock.restore = { phase: 'awaiting-online', startedAt: Date.now() };
    render();
    expect(host.textContent).toContain('restore.awaitingOnline');
});
