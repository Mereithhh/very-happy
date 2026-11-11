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
import { restoreFilesToComposer } from './composerRestore';
import { clearAttachmentStash } from './useAttachments';

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
        expect(pending.onSend).toHaveBeenCalledExactlyOnceWith('typed before reload', []);
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

describe('B-908: Claude draft — 1M by default, a switch-off is remembered for the account', () => {
    type Menu = { pickRow?: (key: string) => string; onLongContextToggle?: (on: boolean) => void };
    const lastMenu = () => mocks.modelMenus[mocks.modelMenus.length - 1] as unknown as Menu;
    const renderClaude = () => act(() => root.render(<AgentInput sessionId="pending-1" agentFlavor="claude" pending={pending} />));
    afterEach(() => { delete (mocks.settings as Record<string, unknown>).claudeLongContextOptOut; });

    // Opus 5.5 is the follow entry here (「跟随最新 · Opus 5.5 · 1M」), already 1M — no row of its own.
    it('a row pick of Fable 5.2 / the fable alias sends the 1M twin; Haiku stays plain', () => {
        renderClaude();
        expect(lastMenu().pickRow!('claude-fable-5-2')).toBe('claude-fable-5-2[1m]');
        expect(lastMenu().pickRow!('fable')).toBe('fable[1m]');
        expect(lastMenu().pickRow!('haiku')).toBe('haiku');
    });

    it('switching 1M off writes the account opt-out; after it a pick stays plain; switching on clears it', () => {
        renderClaude();
        act(() => lastMenu().onLongContextToggle!(false));
        expect(mocks.applySettings).toHaveBeenCalledExactlyOnceWith({ claudeLongContextOptOut: true });
        (mocks.settings as Record<string, unknown>).claudeLongContextOptOut = true;
        renderClaude();
        expect(lastMenu().pickRow!('claude-fable-5-2')).toBe('claude-fable-5-2');
        act(() => lastMenu().onLongContextToggle!(false));
        expect(mocks.applySettings).toHaveBeenCalledOnce();
        act(() => lastMenu().onLongContextToggle!(true));
        expect(mocks.applySettings).toHaveBeenLastCalledWith({ claudeLongContextOptOut: false });
    });

    it('Codex drafts: picks pass through and the switch writes nothing', () => {
        render();
        expect(lastMenu().pickRow!('gpt-6.1-sol')).toBe('gpt-6.1-sol');
        act(() => lastMenu().onLongContextToggle!(false));
        expect(mocks.applySettings).not.toHaveBeenCalled();
    });
});

describe('B-929: files on a pending page', () => {
    // A previous test's unsent files are parked under the same id (B-918) — start clean.
    beforeEach(() => { clearAttachmentStash(); });
    function renderAs(flavor: string) { act(() => root.render(<AgentInput sessionId="pending-1" agentFlavor={flavor} pending={pending} />)); }
    const fileInput = () => host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const thumbs = () => host.querySelectorAll('.ci-att');
    async function pick(...files: File[]) {
        Object.defineProperty(fileInput(), 'files', { configurable: true, value: files });
        await act(async () => { fileInput().dispatchEvent(new Event('change', { bubbles: true })); });
        await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
    }
    const doc = (name = 'notes.pdf') => new File(['%PDF-1'], name, { type: 'application/pdf' });

    it.each(['claude', 'codex'])('%s: a picked file rides with the text into the outbox as one message', async (flavor) => {
        renderAs(flavor);
        expect(fileInput().getAttribute('accept')).toBeNull(); // any file, like a live Claude/Codex session
        await pick(doc());
        expect(thumbs()).toHaveLength(1);
        await enter();
        expect(pending.onSend).toHaveBeenCalledOnce();
        const [text, files] = vi.mocked(pending.onSend).mock.calls[0];
        expect(text).toBe('typed before reload');
        expect(files).toMatchObject([{ name: 'notes.pdf', mimeType: 'application/pdf' }]);
        expect(thumbs()).toHaveLength(0);
        expect(input().value).toBe('');
        expect(mocks.send).not.toHaveBeenCalled();
    });

    it('files only (no text) can be sent', async () => {
        pending.initialDraft = '';
        renderAs('claude');
        await pick(doc());
        await enter();
        expect(pending.onSend).toHaveBeenCalledExactlyOnceWith('', [expect.objectContaining({ name: 'notes.pdf' })]);
    });

    it('not accepted: says why and keeps text AND files in the box (no silent return)', async () => {
        pending.onSend = vi.fn(() => false);
        renderAs('claude');
        await pick(doc());
        await enter();
        expect(mocks.show).toHaveBeenCalledWith('pendingSession.notAccepted', 'info');
        expect(input().value).toBe('typed before reload');
        expect(thumbs()).toHaveLength(1);
    });

    it('an agent that only knows after it starts: paste / drop say so, nothing is added or sent', async () => {
        renderAs('gemini');
        const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
        paste.clipboardData = { items: [{ kind: 'file', getAsFile: () => doc() }], getData: () => '' };
        await act(async () => { input().dispatchEvent(paste); });
        expect(mocks.show).toHaveBeenCalledWith('pendingSession.attachmentsLater', 'info');
        expect(thumbs()).toHaveLength(0);
        await enter();
        expect(pending.onSend).toHaveBeenCalledExactlyOnceWith('typed before reload', []);
    });

    it('files handed back (upload failed / session takes none) reappear in the box; sending again is the retry', async () => {
        renderAs('claude');
        const back = { id: 'r1', uri: 'blob:back/1', width: 4, height: 3, size: 9, name: 'shot.png', mimeType: 'image/png' };
        act(() => { expect(restoreFilesToComposer('pending-1', [back])).toBe(true); });
        expect(thumbs()).toHaveLength(1);
        await enter();
        expect(pending.onSend).toHaveBeenCalledExactlyOnceWith('typed before reload', [back]);
    });

    it('a draft page adopts files a left draft page parked', async () => {
        const left = { id: 'l1', uri: 'blob:left/1', width: 4, height: 3, size: 9, name: 'left.png', mimeType: 'image/png' };
        pending.takeLeftFiles = vi.fn(() => [left]);
        renderAs('claude');
        expect(pending.takeLeftFiles).toHaveBeenCalled();
        expect(thumbs()).toHaveLength(1);
    });
});
