// @vitest-environment happy-dom
/**
 * B-035: `@` file mentions, rendered through the real AgentInput. Trigger,
 * keyboard (B-640 bare-arrow rule), insertion and the no-file-list state.
 * The pure token rules are in fileMention.test.ts.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    session: {
        draft: '  Send this draft  ', presence: 'online', thinking: false,
        metadata: { flavor: 'claude', attachmentKinds: ['*/*'], capabilities: ['claude-steer-v1'] },
        agentState: { controlledByUser: false },
    },
    settings: { agentInputEnterToSend: true, agentDefaultOverrides: {} },
    working: false,
    gate: 'send' as 'send' | 'restore-first',
    queues: {} as Record<string, unknown>,
    send: vi.fn(), paint: vi.fn(), restoreSession: vi.fn(), abort: vi.fn(), draft: vi.fn(),
    btw: vi.fn(), toast: vi.fn(), saveQueue: vi.fn(), modeMeta: vi.fn(),
    commands: [] as Array<{ command: string; description?: string }>,
    projectFiles: null as null | { files: Array<{ fileName: string; filePath: string; fullPath: string }>; fetchedAt: number },
    fetchFiles: vi.fn(),
    applyProjectFiles: vi.fn(),
}));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: mocks.send } }));
vi.mock('@/sync/ops', () => ({ sessionAbort: mocks.abort, sessionSetPermissionMode: vi.fn() }));
// B-568: the socket hint reads the live store; these composer tests mock storage as a plain object.
vi.mock('./useReconnectingHint', () => ({ useReconnectingHint: () => false }));
vi.mock('@/sync/storage', () => ({
    useSession: () => mocks.session,
    useSessionUsage: () => null,
    useSessionProjectFiles: () => mocks.projectFiles,
    useSetting: (key: keyof typeof mocks.settings) => mocks.settings[key],
    storage: { getState: () => ({ settings: mocks.settings, updateSessionDraft: mocks.draft, getSessionPathKey: () => 'm1:/repo', applyProjectFiles: mocks.applyProjectFiles }) },
}));
vi.mock('@/sync/persistence', () => ({ loadQueuedMessages: () => structuredClone(mocks.queues), saveQueuedMessages: mocks.saveQueue }));
vi.mock('@/sync/messageMeta', () => ({ resolveMessageModeMeta: mocks.modeMeta }));
vi.mock('@/sync/suggestionCommands', () => ({ getAllCommands: () => mocks.commands }));
vi.mock('@/sync/heartbeatLease', () => ({ useHeartbeatFresh: () => true }));
vi.mock('@/sync/agentLiveness', () => ({ isAgentWorkLive: () => mocks.working }));
vi.mock('@/app/sessionRestore', () => ({
    composerGate: () => mocks.gate, restoreSession: mocks.restoreSession, useRestoreState: () => null,
}));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/ui', async () => ({
    ...await vi.importActual<typeof import('@/ui/Spinner')>('@/ui/Spinner'),
    useToast: () => ({ error: mocks.toast }),
}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('./ModeMenu', () => ({ ModeMenu: () => null }));
vi.mock('./ModelEffortMenu', () => ({ ModelEffortMenu: () => null }));
vi.mock('./PresetsMenu', () => ({ PresetsMenu: () => null }));
vi.mock('./btwPanelState', () => ({ openBtwPanel: mocks.btw }));
vi.mock('./sendFeedback', () => ({ yieldForSendFeedback: mocks.paint }));
vi.mock('@/sync/projectFiles', () => ({ getProjectFiles: mocks.fetchFiles }));

import { AgentInput } from './AgentInput';

const file = (fullPath: string) => ({ fullPath, filePath: fullPath.split('/').slice(0, -1).join('/'), fileName: fullPath.split('/').pop()! });
const FILES = ['README.md', 'src/screens/session/AgentInput.tsx', 'src/screens/session/fileMention.ts', 'docs/dir x/notes.md'].map(file);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.session.draft = '';
    mocks.commands = [];
    mocks.projectFiles = { files: FILES, fetchedAt: 1 };
    mocks.fetchFiles.mockResolvedValue({ files: FILES, fetchedAt: 2 });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<AgentInput sessionId="session" />));
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

function input() { return host.querySelector<HTMLTextAreaElement>('.ci-textarea')!; }
function options() { return [...host.querySelectorAll<HTMLElement>('.ci-slash [role="option"]')]; }
function list() { return host.querySelector<HTMLElement>('.ci-slash'); }
async function press(init: KeyboardEventInit): Promise<KeyboardEvent> {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    await act(async () => { input().dispatchEvent(event); });
    return event;
}
/** Type `value` with the caret at `|` (default: the end), the way onChange + onKeyUp see it. */
async function type(marked: string) {
    const caret = marked.includes('|') ? marked.indexOf('|') : marked.length;
    const value = marked.replace('|', '');
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), value);
        input().setSelectionRange(caret, caret);
        input().dispatchEvent(new Event('input', { bubbles: true }));
        input().dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'x' }));
    });
}

describe('B-035 @ file mentions in the composer', () => {
    it('`@` mid-message opens the file list, ranked like ⌘P, and refreshes the list once', async () => {
        await type('look at @agentin');
        expect(list()?.getAttribute('aria-label')).toBe('session.chat.fileMentions');
        expect(options()[0].textContent).toContain('AgentInput.tsx');
        expect(options()[0].getAttribute('aria-selected')).toBe('true');
        await type('look at @agentinp');
        expect(mocks.fetchFiles).toHaveBeenCalledTimes(1);
    });

    it('Enter accepts: the token becomes @path + space, nothing is sent, the list closes', async () => {
        await type('look at @agentin');
        const event = await press({ key: 'Enter' });
        expect(event.defaultPrevented).toBe(true);
        expect(input().value).toBe('look at @src/screens/session/AgentInput.tsx ');
        expect(mocks.send).not.toHaveBeenCalled();
        expect(list()).toBeNull();
    });

    it('bare ↓ moves, Tab accepts the highlighted row; a modified ↓ is left to the textarea', async () => {
        await type('@session');
        expect(options().length).toBe(2);
        expect((await press({ key: 'ArrowDown', shiftKey: true })).defaultPrevented).toBe(false);
        expect((await press({ key: 'ArrowDown' })).defaultPrevented).toBe(true);
        expect(options()[1].getAttribute('aria-selected')).toBe('true');
        const second = options()[1].textContent!;
        await press({ key: 'Tab' });
        expect(input().value).toContain(second.includes('fileMention') ? '@src/screens/session/fileMention.ts ' : '@src/screens/session/AgentInput.tsx ');
    });

    it('a path with a space is inserted quoted (Claude Code expands @"a b")', async () => {
        await type('@notes');
        await press({ key: 'Enter' });
        expect(input().value).toBe('@"docs/dir x/notes.md" ');
    });

    it('replaces only the token under the caret and keeps the text after it', async () => {
        await type('see @fileme| please');
        await press({ key: 'Enter' });
        expect(input().value).toBe('see @src/screens/session/fileMention.ts please');
    });

    it('Escape dismisses this token; editing it reopens the list', async () => {
        await type('@agent');
        expect((await press({ key: 'Escape' })).defaultPrevented).toBe(true);
        expect(list()).toBeNull();
        await type('@agentI');
        expect(list()).not.toBeNull();
    });

    it('does not trigger for an e-mail, and a typed space closes the list', async () => {
        await type('mail me at a@agent');
        expect(list()).toBeNull();
        await type('@agent ');
        expect(list()).toBeNull();
    });

    it('with no file list it says loading, then unavailable — never an empty popup', async () => {
        mocks.projectFiles = null;
        mocks.fetchFiles.mockResolvedValue(null);
        act(() => root.render(<AgentInput sessionId="session" />));
        let resolve!: (v: null) => void;
        mocks.fetchFiles.mockReturnValue(new Promise<null>((r) => { resolve = r; }));
        await type('@x');
        expect(list()?.textContent).toContain('session.chat.fileMentionsLoading');
        await act(async () => { resolve(null); await new Promise((r) => setTimeout(r, 0)); });
        expect(options()).toHaveLength(0);
        expect(list()?.textContent).toContain('session.chat.fileMentionsUnavailable');
        expect(mocks.applyProjectFiles).not.toHaveBeenCalled();
    });

    it('while the / command list is open, @ does not compete with it', async () => {
        mocks.commands = [{ command: 'review' }];
        await type('/re');
        expect(list()?.getAttribute('aria-label')).toBe('session.chat.slashCommands');
    });
});
