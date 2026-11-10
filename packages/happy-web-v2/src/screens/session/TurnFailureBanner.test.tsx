// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
    session: null as any,
    messages: [] as any[],
    sendMessage: vi.fn(),
    toastError: vi.fn(),
}));
vi.mock('@/sync/storage', () => ({
    useSession: () => mock.session,
    useSessionMessages: () => ({ messages: mock.messages, isLoaded: true, hasMoreOlder: false, isLoadingOlder: false }),
}));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: mock.sendMessage } }));
vi.mock('@/ui', () => ({ useToast: () => ({ error: mock.toastError }) }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { TurnFailureBanner } from './TurnFailureBanner';

let host: HTMLDivElement, root: Root;
const render = () => act(() => root.render(<TurnFailureBanner sessionId="s1" />));
const banner = () => host.querySelector('[data-testid="turn-failure-banner"]');
const retryButton = () => host.querySelector<HTMLButtonElement>('.mrb-term-btn');

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mock.session = {
        archivedAt: null, thinking: false,
        metadata: { capabilities: ['turn-failure-v1'] },
        agentState: { turnFailure: { at: 100, summary: 'API Error: 400 bad request', provider: 'claude', status: 400 } },
    };
    // newest-first, like storage
    mock.messages = [
        { kind: 'agent-text', id: 'a1', text: 'API Error: 400 bad request' },
        { kind: 'user-text', id: 'u2', text: 'fix the build', displayText: 'fix the build' },
        { kind: 'user-text', id: 'u1', text: 'older' },
    ];
    mock.sendMessage.mockResolvedValue(undefined);
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('shows the summary and 重试 resends the last user message once, then hides', async () => {
    render();
    expect(banner()).not.toBeNull();
    expect(host.textContent).toContain('session.chat.turnFailedTitle');
    expect(host.querySelector('[data-testid="turn-failure-summary"]')?.textContent).toBe('API Error: 400 bad request');
    await act(async () => { retryButton()!.click(); });
    expect(mock.sendMessage).toHaveBeenCalledExactlyOnceWith('s1', 'fix the build', { source: 'chat', displayText: 'fix the build' });
    expect(banner()).toBeNull();
});

it('a NEW failure after a retry shows again', async () => {
    render();
    await act(async () => { retryButton()!.click(); });
    expect(banner()).toBeNull();
    mock.session = { ...mock.session, agentState: { turnFailure: { at: 200, summary: 'API Error: 529 Overloaded', status: 529 } } };
    render();
    expect(banner()).not.toBeNull();
    expect(host.textContent).toContain('API Error: 529 Overloaded');
});

it('a failed resend keeps the banner and says why', async () => {
    mock.sendMessage.mockRejectedValueOnce(new Error('offline'));
    render();
    await act(async () => { retryButton()!.click(); });
    expect(mock.toastError).toHaveBeenCalledOnce();
    expect(banner()).not.toBeNull();
});

it('no user message loaded → no 重试, the banner still informs; 隐藏 puts it away', () => {
    mock.messages = [{ kind: 'agent-text', id: 'a1', text: 'x' }];
    render();
    expect(retryButton()).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('.mrb-dismiss')!.click());
    expect(banner()).toBeNull();
});

it('old CLI / running turn / cleared failure → nothing', () => {
    mock.session = { ...mock.session, metadata: { capabilities: [] } };
    render();
    expect(banner()).toBeNull();
    mock.session = { ...mock.session, metadata: { capabilities: ['turn-failure-v1'] }, thinking: true };
    render();
    expect(banner()).toBeNull();
    mock.session = { ...mock.session, thinking: false, agentState: { turnFailure: null } };
    render();
    expect(banner()).toBeNull();
});
