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
