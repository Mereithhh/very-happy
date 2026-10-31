// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
    session: null as any,
    machine: null as any,
    dismissed: {} as Record<string, number>,
    setDismissed: vi.fn(),
    restart: undefined as any,
    restartSession: vi.fn(),
}));
vi.mock('@/sync/storage', () => ({
    useSession: () => mock.session,
    storage: (selector: any) => selector({ machines: mock.machine ? { m1: mock.machine } : {} }),
    useLocalSettingMutable: () => [mock.dismissed, mock.setDismissed],
    useSetting: () => undefined,
}));
vi.mock('@/app/sessionRestartAction', () => ({
    restartBrokenSession: mock.restartSession,
    useRestartState: () => mock.restart,
}));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { StaleWrapperBanner } from './StaleWrapperBanner';

let host: HTMLDivElement, root: Root;
const render = () => act(() => root.render(<StaleWrapperBanner sessionId="s1" />));
const banner = () => host.querySelector('[data-testid="stale-wrapper-banner"]');

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mock.session = { archivedAt: null, metadata: { machineId: 'm1', version: '0.2.104' } };
    mock.machine = { active: true, daemonState: { startedWithCliVersion: '0.2.141' } };
    mock.dismissed = {};
    mock.restart = undefined;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('warns about a wrapper that can drop messages and offers the restart', () => {
    render();
    expect(host.textContent).toContain('staleWrapper.criticalNotice');
    expect(banner()?.getAttribute('data-severity')).toBe('critical');
    act(() => host.querySelector<HTMLButtonElement>('.mrb-term-btn')!.click());
    expect(mock.restartSession).toHaveBeenCalledExactlyOnceWith('s1');
});

it('uses the plain wording for a wrapper that is merely behind', () => {
    mock.session.metadata.version = '0.2.140';
    render();
    expect(host.textContent).toContain('staleWrapper.behindNotice');
    expect(banner()?.getAttribute('data-severity')).toBe('behind');
});

it('says nothing when the wrapper matches the machine', () => {
    mock.session.metadata.version = '0.2.141';
    render();
    expect(banner()).toBeNull();
});

it('remembers a dismissal per session and wrapper version', () => {
    render();
    act(() => host.querySelector<HTMLButtonElement>('.mrb-dismiss')!.click());
    expect(mock.setDismissed).toHaveBeenCalledTimes(1);
    const written = mock.setDismissed.mock.calls[0][0];
    expect(typeof written['stale-wrapper:s1:0.2.104']).toBe('number');
    mock.dismissed = written;
    render();
    expect(banner()).toBeNull();
});

it('still shows a restart in flight and a failure the user dismissed earlier', () => {
    mock.dismissed = { 'stale-wrapper:s1:0.2.104': Date.now() };
    mock.restart = { phase: 'spawning', startedAt: Date.now() };
    render();
    expect(host.textContent).toContain('session.chat.restarting');
    expect(host.querySelector<HTMLButtonElement>('.mrb-term-btn')!.disabled).toBe(true);
    mock.restart = { phase: 'failed', startedAt: Date.now(), reason: 'daemon-too-old' };
    render();
    expect(host.textContent).toContain('session.chat.restartDaemonTooOld');
    expect(host.querySelector<HTMLButtonElement>('.mrb-term-btn')!.disabled).toBe(false);
});

it('steps aside for the Opus 5.5 notice, which offers the same restart with the reason', () => {
    mock.session = { archivedAt: null, modelMode: null, metadata: { machineId: 'm1', flavor: 'claude', version: '0.2.148', capabilities: [] } };
    mock.machine = { active: true, daemonState: { startedWithCliVersion: '0.2.149' } };
    render();
    expect(banner()).toBeNull();
    // Once the Opus notice is dismissed the plain stale-wrapper strip returns.
    mock.dismissed = { 'model-support:s1:claude-opus-55:claude-opus-5-5:0.2.148': 1 };
    render();
    expect(host.textContent).toContain('staleWrapper.behindNotice');
});

// B-852: the daemon restarts stale wrappers by itself; the banner only asks a human when needed.
const autoRestart = (sessions: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const now = Date.now();
    mock.machine.daemonState = {
        ...mock.machine.daemonState,
        startedAt: now - 10 * 60_000,
        autoRestart: { enabled: true, rpcAvailable: true, detectedAt: now, sessions, ...extra },
    };
};

it('B-852: hidden while the daemon is waiting (briefly) or restarting it', () => {
    autoRestart({ s1: { state: 'waiting', reason: 'recent-activity', since: Date.now() - 60_000, target: '0.2.141' } });
    render();
    expect(banner()).toBeNull();
    autoRestart({ s1: { state: 'restarting', since: Date.now(), target: '0.2.141' } });
    render();
    expect(banner()).toBeNull();
});

it('B-852: after a long wait it says why and keeps the manual restart', () => {
    autoRestart({ s1: { state: 'waiting', reason: 'background-tasks', since: Date.now() - 61 * 60_000, target: '0.2.141' } });
    render();
    expect(host.textContent).toContain('autoRestart.waiting');
    expect(banner()?.getAttribute('data-auto-restart')).toBe('waiting');
    act(() => host.querySelector<HTMLButtonElement>('.mrb-term-btn')!.click());
    expect(mock.restartSession).toHaveBeenCalledExactlyOnceWith('s1');
});

it('B-852: a failed automatic restart and a never-provable wrapper go back to the button', () => {
    autoRestart({ s1: { state: 'failed', reason: 'restart-precheck:cwd-missing: /x', since: Date.now(), target: '0.2.141' } });
    render();
    expect(host.textContent).toContain('autoRestart.failed');
    autoRestart({ s1: { state: 'manual', reason: 'no-report', since: Date.now(), target: '0.2.141' } });
    render();
    expect(host.textContent).toContain('staleWrapper.criticalNotice');
});

it('QA25 P2-1: a session in the user\'s terminal shows the manual banner at once, saying why', () => {
    autoRestart({ s1: { state: 'manual', reason: 'local-terminal', since: Date.now(), target: '0.2.141' } });
    render();
    expect(host.textContent).toContain('autoRestart.manualLocalTerminal');
    expect(banner()?.getAttribute('data-auto-restart')).toBe('manual');
    act(() => host.querySelector<HTMLButtonElement>('.mrb-term-btn')!.click());
    expect(mock.restartSession).toHaveBeenCalledExactlyOnceWith('s1');
});

it('B-852: switch off, or a stamp from an older daemon run → the old banner', () => {
    autoRestart({}, { enabled: false });
    render();
    expect(host.textContent).toContain('staleWrapper.criticalNotice');
    autoRestart({ s1: { state: 'restarting', since: Date.now(), target: '0.2.141' } }, { detectedAt: 1 });
    render();
    expect(host.textContent).toContain('staleWrapper.criticalNotice');
});

it('B-852: unlisted right after the daemon started → quiet; unlisted later → the old banner', () => {
    autoRestart({});
    mock.machine.daemonState.startedAt = Date.now() - 30_000;
    render();
    expect(banner()).toBeNull();
    mock.machine.daemonState.startedAt = Date.now() - 10 * 60_000;
    render();
    expect(host.textContent).toContain('staleWrapper.criticalNotice');
});
