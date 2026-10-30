// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
    session: null as any,
    machine: null as any,
    overrides: undefined as any,
    dismissed: {} as Record<string, number>,
    setDismissed: vi.fn(),
    restart: undefined as any,
    restartSession: vi.fn(),
    requestUpdate: vi.fn(),
}));
vi.mock('@/sync/storage', () => ({
    useSession: () => mock.session,
    storage: (selector: any) => selector({ machines: mock.machine ? { m1: mock.machine } : {} }),
    useLocalSettingMutable: () => [mock.dismissed, mock.setDismissed],
    useSetting: () => mock.overrides,
}));
vi.mock('@/app/sessionRestartAction', () => ({
    restartBrokenSession: mock.restartSession,
    useRestartState: () => mock.restart,
}));
vi.mock('@/app/cliUpdateRecovery', () => ({ requestMachineUpdate: mock.requestUpdate }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { ModelSupportBanner } from './ModelSupportBanner';

let host: HTMLDivElement, root: Root;
const render = () => act(() => root.render(<ModelSupportBanner sessionId="s1" />));
const banner = () => host.querySelector('[data-testid="model-support-banner"]');
const click = async (testId: string) => {
    await act(async () => { host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click(); });
};

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mock.session = { archivedAt: null, modelMode: null, metadata: { machineId: 'm1', flavor: 'claude', version: '0.2.148', capabilities: ['claude-steer-v1'] } };
    mock.machine = { active: true, daemonState: { startedWithCliVersion: '0.2.148', cliUpdate: { manualUpdateSupported: true, recommendedVersion: '0.2.150' } } };
    mock.overrides = undefined;
    mock.dismissed = {};
    mock.restart = undefined;
    mock.requestUpdate.mockResolvedValue(undefined);
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('tells an old-CLI Claude session why Opus 5.5 is not running and requests the update', async () => {
    render();
    expect(banner()?.getAttribute('data-notice')).toBe('claude-opus-55');
    expect(host.textContent).toContain('modelSupport.opusUpdate');
    await click('model-support-update');
    expect(mock.requestUpdate).toHaveBeenCalledExactlyOnceWith('m1', '0.2.150');
    expect(host.textContent).toContain('modelSupport.updateRequested');
    await click('model-support-restart');
    expect(mock.restartSession).toHaveBeenCalledExactlyOnceWith('s1');
});

it('falls back to the copyable command when the daemon cannot take an update request', async () => {
    mock.machine.daemonState.cliUpdate.manualUpdateSupported = false;
    render();
    await click('model-support-update');
    expect(mock.requestUpdate).not.toHaveBeenCalled();
    expect(host.querySelector('.mrb-cmd code')?.textContent).toContain('very-happy-cli@0.2.150');
});

it('only offers the restart when the machine already has a capable CLI', () => {
    mock.machine.daemonState.startedWithCliVersion = '0.2.149';
    render();
    expect(banner()?.getAttribute('data-action')).toBe('restart');
    expect(host.querySelector('[data-testid="model-support-update"]')).toBeNull();
});

it('shows the Codex command for gpt-6 models missing from the catalog', async () => {
    mock.session = { archivedAt: null, modelMode: 'gpt-6-sol', metadata: { machineId: 'm1', flavor: 'codex', models: [{ code: 'gpt-5.5' }] } };
    render();
    expect(banner()?.getAttribute('data-notice')).toBe('codex-gpt6');
    await click('model-support-command');
    expect(host.querySelector('.mrb-cmd code')?.textContent).toBe('npm install -g @openai/codex@latest');
});

it('can be dismissed, and says nothing when the model can run', () => {
    render();
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="model-support-dismiss"]')!.click());
    expect(mock.setDismissed).toHaveBeenCalledWith({ 'model-support:s1:claude-opus-55:claude-opus-5-5:0.2.148': expect.any(Number) });
    mock.dismissed = { 'model-support:s1:claude-opus-55:claude-opus-5-5:0.2.148': 1 };
    render();
    expect(banner()).toBeNull();
    mock.dismissed = {};
    mock.session.metadata.capabilities = ['claude-opus-5-5-v1'];
    render();
    expect(banner()).toBeNull();
});

// B-852: "restart to use the new model" is the daemon's job now.
const withAutoRestart = (sessions: Record<string, unknown>) => {
    const now = Date.now();
    Object.assign(mock.machine.daemonState, { startedAt: now - 10 * 60_000, autoRestart: { enabled: true, rpcAvailable: true, detectedAt: now, sessions } });
};

it('B-852: a restart-only Opus notice is hidden while the daemon restarts it; shown with the reason after a long wait', () => {
    mock.machine.daemonState.startedWithCliVersion = '0.2.149';
    withAutoRestart({ s1: { state: 'waiting', reason: 'pending-request', since: Date.now() - 60_000, target: '0.2.149' } });
    render();
    expect(banner()).toBeNull();
    withAutoRestart({ s1: { state: 'waiting', reason: 'pending-request', since: Date.now() - 2 * 60 * 60_000, target: '0.2.149' } });
    render();
    expect(host.textContent).toContain('autoRestart.waiting');
    expect(host.querySelector('[data-testid="model-support-restart"]')).not.toBeNull();
});

it('B-852: an update notice is never hidden (the daemon cannot install it for a restart)', () => {
    withAutoRestart({ s1: { state: 'waiting', reason: 'recent-activity', since: Date.now(), target: '0.2.148' } });
    render();
    expect(banner()?.getAttribute('data-action')).toBe('update');
});

it('B-852: a Codex restart the daemon has not listed stays manual; a listed one is automatic', () => {
    mock.session = { archivedAt: null, modelMode: 'gpt-6-sol', metadata: { machineId: 'm1', flavor: 'codex', models: [{ code: 'gpt-5.5' }] } };
    Object.assign(mock.machine.daemonState, { pid: 7, agentVersionEpoch: 1, agentVersions: { checkedAt: Date.now(), daemonPid: 7, agents: [{ id: 'codex', installed: '0.156.0', latest: '0.156.0', status: 'current' }] } });
    withAutoRestart({});
    render();
    expect(banner()?.getAttribute('data-action')).toBe('restart');
    withAutoRestart({ s1: { state: 'restarting', since: Date.now(), target: '0.156.0' } });
    render();
    expect(banner()).toBeNull();
});
