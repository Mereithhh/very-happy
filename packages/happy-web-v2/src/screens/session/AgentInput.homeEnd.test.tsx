// @vitest-environment happy-dom
/**
 * B-640: "Home / End do nothing in the composer". The composer must leave
 * caret/selection keys to the browser: it never preventDefaults them, in any
 * composer state, and no global chord matcher claims them. Platform behaviour
 * is then exactly the native textarea's (Windows/Linux: line start/end;
 * macOS: Home/End scroll and leave the caret, ⌘←/⌘→ move it) — verified in
 * real Chromium (Linux, macOS) and WebKit (macOS), see the PR.
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
}));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: mocks.send } }));
vi.mock('@/sync/ops', () => ({ sessionAbort: mocks.abort, sessionSetPermissionMode: vi.fn() }));
// B-568: the socket hint reads the live store; these composer tests mock storage as a plain object.
vi.mock('./useReconnectingHint', () => ({ useReconnectingHint: () => false }));
vi.mock('@/sync/storage', () => ({
    useMachine: () => null, // B-688 picker 「自定义…」 (no machine → no entry)
    useSession: () => mocks.session,
    useSessionUsage: () => null,
    useSessionProjectFiles: () => null, // B-035 @ mentions (unused until `@` is typed)
    useSetting: (key: keyof typeof mocks.settings) => mocks.settings[key],
    storage: { getState: () => ({ settings: mocks.settings, updateSessionDraft: mocks.draft }) },
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

import { AgentInput } from './AgentInput';
import { matchBackChord } from '@/app/appBack';
import { matchCloseViewChord } from '@/app/closeGuard';
import { matchPresetsMenuChord } from '@/app/presetsShortcut';

/** Caret / selection keys on every platform: Home/End family plus the macOS ⌘/⌥ arrows. */
const NAV_KEYS: KeyboardEventInit[] = [
    { key: 'Home', code: 'Home' }, { key: 'End', code: 'End' },
    { key: 'Home', code: 'Home', shiftKey: true }, { key: 'End', code: 'End', shiftKey: true },
    { key: 'Home', code: 'Home', ctrlKey: true }, { key: 'End', code: 'End', ctrlKey: true },
    { key: 'Home', code: 'Home', ctrlKey: true, shiftKey: true }, { key: 'End', code: 'End', ctrlKey: true, shiftKey: true },
    { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true }, { key: 'ArrowRight', code: 'ArrowRight', metaKey: true },
    { key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, shiftKey: true }, { key: 'ArrowRight', code: 'ArrowRight', metaKey: true, shiftKey: true },
    { key: 'ArrowUp', code: 'ArrowUp', metaKey: true }, { key: 'ArrowDown', code: 'ArrowDown', metaKey: true },
    { key: 'ArrowUp', code: 'ArrowUp', shiftKey: true }, { key: 'ArrowDown', code: 'ArrowDown', shiftKey: true },
    { key: 'ArrowUp', code: 'ArrowUp', altKey: true }, { key: 'ArrowDown', code: 'ArrowDown', altKey: true },
];
const label = (k: KeyboardEventInit) => [k.ctrlKey && 'Ctrl', k.metaKey && 'Meta', k.altKey && 'Alt', k.shiftKey && 'Shift', k.key].filter(Boolean).join('+');

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.session.draft = 'first line here\nsecond line text';
    mocks.commands = [];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

function input() { return host.querySelector<HTMLTextAreaElement>('.ci-textarea')!; }
async function press(init: KeyboardEventInit): Promise<KeyboardEvent> {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    await act(async () => { input().dispatchEvent(event); });
    return event;
}
function changeDraft(value: string) {
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), value);
        input().dispatchEvent(new Event('input', { bubbles: true }));
    });
}

describe('composer leaves Home / End to the browser (B-640)', () => {
    it('the keydown handler is attached: Enter IS taken (proves the cases below can fail)', async () => {
        act(() => root.render(<AgentInput sessionId="session" />));
        expect((await press({ key: 'Enter', code: 'Enter' })).defaultPrevented).toBe(true);
    });

    it.each(NAV_KEYS.map((k) => [label(k), k] as const))('%s is not prevented', async (_name, init) => {
        act(() => root.render(<AgentInput sessionId="session" />));
        const event = await press(init);
        expect(event.defaultPrevented).toBe(false);
        expect(mocks.send).not.toHaveBeenCalled();
        expect(input().value).toBe('first line here\nsecond line text');
    });

    it('not even while the slash-command list is open (that branch owns bare ↑/↓, Tab, Esc only)', async () => {
        mocks.commands = [{ command: 'compact' }, { command: 'clear' }];
        act(() => root.render(<AgentInput sessionId="session" />));
        changeDraft('/c');
        expect((await press({ key: 'ArrowDown', code: 'ArrowDown' })).defaultPrevented).toBe(true);
        for (const init of NAV_KEYS) expect((await press(init)).defaultPrevented, label(init)).toBe(false);
    });

    it('no global chord matcher claims them on a text field', () => {
        const target = document.createElement('textarea');
        for (const init of NAV_KEYS) {
            const e = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, code: '', ...init, key: init.key!, target };
            expect(matchBackChord(e), label(init)).toBe(false);
            expect(matchCloseViewChord(e), label(init)).toBe(false);
            expect(matchPresetsMenuChord(e), label(init)).toBe(false);
        }
    });
});
