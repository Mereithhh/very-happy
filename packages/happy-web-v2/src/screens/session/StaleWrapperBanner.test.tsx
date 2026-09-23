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
