// @vitest-environment happy-dom
// B-516: the composer on an optimistic pending page (no session yet).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: { agentInputEnterToSend: true, agentDefaultOverrides: {} as Record<string, unknown> },
    send: vi.fn(), draft: vi.fn(), perm: vi.fn(), applySettings: vi.fn(), show: vi.fn(), btw: vi.fn(),
    modeMenus: [] as Array<{ label: string; value: string; onChange: (key: string) => void }>,
}));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: mocks.send, applySettings: mocks.applySettings } }));
vi.mock('@/sync/ops', () => ({ sessionAbort: vi.fn(), sessionSetPermissionMode: vi.fn() }));
vi.mock('@/sync/storage', () => ({
    useSession: () => null,
    useSessionUsage: () => null,
    useSetting: (key: keyof typeof mocks.settings) => mocks.settings[key],
    storage: { getState: () => ({ settings: mocks.settings, updateSessionDraft: mocks.draft, updateSessionPermissionMode: mocks.perm }) },
}));
vi.mock('@/sync/persistence', () => ({ loadQueuedMessages: () => ({}), saveQueuedMessages: vi.fn() }));
vi.mock('@/sync/messageMeta', () => ({ resolveMessageModeMeta: () => ({}) }));
vi.mock('@/sync/suggestionCommands', () => ({ getAllCommands: () => [] }));
vi.mock('@/sync/heartbeatLease', () => ({ useHeartbeatFresh: () => true }));
vi.mock('@/app/sessionRestore', () => ({ composerGate: () => 'send', restoreSession: vi.fn(), useRestoreState: () => null }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/ui', async () => ({
    ...await vi.importActual<typeof import('@/ui/Spinner')>('@/ui/Spinner'),
    useToast: () => ({ error: vi.fn(), show: mocks.show }),
}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('./ModeMenu', () => ({
    ModeMenu: (props: { label: string; value: string; onChange: (key: string) => void }) => { mocks.modeMenus.push(props); return null; },
}));
vi.mock('./ModelEffortMenu', () => ({ ModelEffortMenu: () => null }));
vi.mock('./PresetsMenu', () => ({ PresetsMenu: () => null }));
vi.mock('./btwPanelState', () => ({ openBtwPanel: mocks.btw }));

import { AgentInput, type PendingComposer } from './AgentInput';

let host: HTMLDivElement;
let root: Root;
let pending: PendingComposer;

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.modeMenus.length = 0;
    pending = {
        onSend: vi.fn(() => true),
        permissionMode: 'plan',
        onMode: vi.fn(),
        initialDraft: 'typed before reload',
    };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

function render() { act(() => root.render(<AgentInput sessionId="pending-1" agentFlavor="codex" pending={pending} />)); }
function input() { return host.querySelector<HTMLTextAreaElement>('.ci-textarea')!; }
function changeDraft(value: string) {
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), value);
        input().dispatchEvent(new Event('input', { bubbles: true }));
    });
}
async function enter() {
    await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
}

describe('AgentInput on a pending page (B-516)', () => {
    it('starts from the pending draft and sends into the outbox, never through sync', async () => {
        render();
        expect(input().value).toBe('typed before reload');
        await enter();
        expect(pending.onSend).toHaveBeenCalledExactlyOnceWith('typed before reload');
        expect(mocks.send).not.toHaveBeenCalled();
        expect(input().value).toBe('');
        expect(mocks.draft).toHaveBeenCalledWith('pending-1', null);
    });

    it('keeps the text when the outbox does not accept it, and keeps /btw out of the outbox', async () => {
        pending.onSend = vi.fn(() => false);
        render();
        await enter();
        expect(input().value).toBe('typed before reload');
        changeDraft('/btw what is this?');
        await enter();
        expect(pending.onSend).toHaveBeenCalledTimes(1);
        expect(mocks.btw).not.toHaveBeenCalled();
        expect(mocks.show).toHaveBeenCalledWith('pendingSession.btwLater', 'info');
        expect(input().value).toBe('/btw what is this?');
    });

    it('says why a send was not accepted (failed start / other tab) and keeps the text', async () => {
        pending.onSend = vi.fn(() => false);
        pending.blockedHint = 'pendingSession.retryFirst';
        render();
        await enter();
        expect(mocks.show).toHaveBeenCalledWith('pendingSession.retryFirst', 'info');
        expect(input().value).toBe('typed before reload');
    });

    it('writes mode choices to the pending record and the chosen agent defaults slot, not a session or Claude', () => {
        render();
        const menu = mocks.modeMenus.at(-1)!;
        expect(menu.value).toBe('plan');
        act(() => menu.onChange('default'));
        expect(pending.onMode).toHaveBeenCalledWith('permissionMode', 'default');
        expect(mocks.perm).not.toHaveBeenCalled();
        const written = mocks.applySettings.mock.calls.at(-1)![0].agentDefaultOverrides as Record<string, { permissionMode?: string }>;
        expect(written.codex?.permissionMode).toBe('default');
        expect(written.claude).toBeUndefined();
    });
});
