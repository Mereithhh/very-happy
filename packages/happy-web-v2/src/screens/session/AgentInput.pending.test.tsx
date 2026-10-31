// @vitest-environment happy-dom
// B-516: the composer on an optimistic pending page (no session yet).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: { agentInputEnterToSend: true, agentDefaultOverrides: {} as Record<string, unknown> },
    send: vi.fn(), draft: vi.fn(), perm: vi.fn(), applySettings: vi.fn(), show: vi.fn(), btw: vi.fn(),
    modeMenus: [] as Array<{ label: string; value: string; onChange: (key: string) => void }>,
    modelMenus: [] as Array<{ value: string | null; onChange: (key: string) => void; effort: { onChange: (key: string) => void; options: Array<{ key: string; name: string }>; value: string | null }; footer?: { action?: { onSelect: () => void } } }>,
    confirm: vi.fn(async () => true),
}));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: mocks.send, applySettings: mocks.applySettings } }));
vi.mock('@/sync/ops', () => ({ sessionAbort: vi.fn(), sessionSetPermissionMode: vi.fn() }));
// B-568: the socket hint reads the live store; these composer tests mock storage as a plain object.
vi.mock('./useReconnectingHint', () => ({ useReconnectingHint: () => false }));
vi.mock('@/sync/storage', () => ({
    useMachine: () => null, // B-688 picker 「自定义…」 (no machine → no entry)
    useSession: () => null,
    useSessionUsage: () => null,
    useSessionProjectFiles: () => null, // B-035 @ mentions (unused until `@` is typed)
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
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: mocks.confirm } }));
vi.mock('./ModeMenu', () => ({
    ModeMenu: (props: { label: string; value: string; onChange: (key: string) => void }) => { mocks.modeMenus.push(props); return null; },
}));
vi.mock('./ModelEffortMenu', () => ({ ModelEffortMenu: (props: (typeof mocks.modelMenus)[number]) => { mocks.modelMenus.push(props); return null; } }));
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
    mocks.modelMenus.length = 0;
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

    it('does not write a discarded pending page\'s draft back on unmount', () => {
        let gone = false;
        pending.isGone = () => gone;
        render();
        changeDraft('half typed');
        gone = true; // sidebar ✕ / ⌘W discarded the record and cleared its keys
        act(() => root.render(<div />));
        expect(mocks.draft).not.toHaveBeenCalledWith('pending-1', 'half typed');
        // a live pending page still flushes
        gone = false;
        render();
        changeDraft('keep me');
        act(() => root.render(<div />));
        expect(mocks.draft).toHaveBeenCalledWith('pending-1', 'keep me');
    });

    // B-848 (B-849a step 1): a pick changes this draft/session only — never the account default.
    it('writes mode choices to the pending record only, never a session or the account defaults', () => {
        render();
        const menu = mocks.modeMenus.at(-1)!;
        expect(menu.value).toBe('plan');
        act(() => menu.onChange('default'));
        expect(pending.onMode).toHaveBeenCalledWith('permissionMode', 'default');
        expect(mocks.perm).not.toHaveBeenCalled();
        const model = mocks.modelMenus.at(-1)!;
        act(() => model.onChange('gpt-5.6-terra'));
        expect(pending.onMode).toHaveBeenCalledWith('modelMode', 'gpt-5.6-terra');
        // 「跟随最新」 is stored as the session's own choice, not as "no pick" (= account default).
        act(() => model.onChange('latest'));
        expect(pending.onMode).toHaveBeenLastCalledWith('modelMode', 'latest');
        act(() => model.effort.onChange('high'));
        expect(pending.onMode).toHaveBeenLastCalledWith('effortLevel', 'high');
        expect(mocks.applySettings).not.toHaveBeenCalled();
    });

    it('「设为新会话默认」 is the explicit, confirmed way to the account default (the session flavor slot)', async () => {
        pending.modelMode = 'gpt-5.6-terra';
        pending.effortLevel = 'high';
        render();
        const action = mocks.modelMenus.at(-1)!.footer?.action;
        expect(action).toBeDefined();
        mocks.confirm.mockResolvedValueOnce(false);
        await act(async () => { action!.onSelect(); });
        expect(mocks.applySettings).not.toHaveBeenCalled();
        await act(async () => { action!.onSelect(); });
        expect(mocks.confirm).toHaveBeenCalledTimes(2);
        const written = mocks.applySettings.mock.calls.at(-1)![0].agentDefaultOverrides as Record<string, { modelMode?: string; effortLevel?: string }>;
        expect(written).toEqual({ codex: { modelMode: 'gpt-5.6-terra', effortLevel: 'high' } });
    });

    it('QA26 P2-5: a Codex draft offers 「自动（中）」 (a new wrapper starts at medium), selected until a level is picked', () => {
        render();
        const effort = mocks.modelMenus.at(-1)!.effort;
        expect(effort.options[0]).toMatchObject({ key: 'default', name: 'session.chat.effortAuto' });
        expect(effort.value).toBe('default');
        act(() => effort.onChange('default'));
        expect(pending.onMode).toHaveBeenLastCalledWith('effortLevel', null);
    });

    it('QA26 P2-5: no 「自动」 when the account default names a level (that level is what gets sent)', () => {
        mocks.settings.agentDefaultOverrides = { codex: { effortLevel: 'high' } };
        try {
            render();
            const effort = mocks.modelMenus.at(-1)!.effort;
            expect(effort.options.map((o) => o.key)).not.toContain('default');
            expect(effort.value).toBe('high');
        } finally { mocks.settings.agentDefaultOverrides = {}; }
    });
});
