// @vitest-environment happy-dom
// B-977c: the Codex 「上下文」 row on a draft (no session yet) — the machine's window table decides it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: { agentInputEnterToSend: true, agentDefaultOverrides: {} as Record<string, unknown> },
    send: vi.fn(), draft: vi.fn(), perm: vi.fn(), applySettings: vi.fn(), show: vi.fn(), btw: vi.fn(),
    modeMenus: [] as Array<{ label: string; value: string; onChange: (key: string) => void }>,
    modelMenus: [] as Array<{ context?: { label: string; options: Array<{ key: string; name: string }>; value: string | null; onChange: (key: string) => void; hint?: string }; value: string | null; onChange: (key: string) => void; effort: { onChange: (key: string) => void; options: Array<{ key: string; name: string }>; value: string | null }; footer?: { action?: { onSelect: () => void } } }>,
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
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string, params?: Record<string, string>) => params ? `${key}|${Object.values(params).join(',')}` : key }) }));
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

const WINDOWS = { 'gpt-6.2-astra': { standard: 258400, extended: 828400 } };
const MODELS = [
    { code: 'gpt-6.2-astra', value: 'gpt-6.2-astra', description: null, reasoningEfforts: ['low', 'medium', 'high'] },
    { code: 'gpt-5.5', value: 'gpt-5.5', description: null, reasoningEfforts: ['low', 'medium', 'high'] },
];
function launcher(extra: Record<string, unknown> | null) {
    return {
        context: { cliVersion: '0.2.232', agentVersion: null, catalog: MODELS, configuredModel: 'gpt-6.2-astra', longContextUnsupported: false },
        catalogs: extra === null ? [] : [{ flavor: 'codex', machineId: 'm1', models: MODELS, configuredModel: 'gpt-6.2-astra', ...extra }],
    } as unknown as PendingComposer['launcher'];
}

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.modelMenus.length = 0;
    mocks.settings.agentDefaultOverrides = {};
    pending = { onSend: vi.fn(() => true), permissionMode: 'plan', onMode: vi.fn(), initialDraft: '', modelMode: 'gpt-6.2-astra', launcher: launcher({ codexContextWindows: WINDOWS }) };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    mocks.settings.agentDefaultOverrides = {};
});

function render() { act(() => root.render(<AgentInput sessionId="pending-1" agentFlavor="codex" pending={pending} />)); }
const menu = () => mocks.modelMenus.at(-1)!;

describe('B-977c: Codex draft 「上下文」', () => {
    it('shows the row from the machine window table, Extended selected, with the new-session default hint', () => {
        render();
        const context = menu().context!;
        expect(context).toBeDefined();
        expect(context.options.map((o) => o.key)).toEqual(['standard', 'extended']);
        expect(context.options[1].name).toBe('session.chat.contextExtended|82.8 万');
        expect(context.options[0].name).toBe('session.chat.contextStandard|25.8 万');
        expect(context.value).toBe('extended');
        expect(context.hint).toContain('session.chat.contextDefaultHint');
        expect(context.hint).toContain('session.chat.contextExtended|82.8 万');
    });

    it('shows the row for the machine-configured model when no model is picked yet (follow-latest / default)', () => {
        pending.modelMode = undefined;
        render();
        expect(menu().context?.value).toBe('extended');
    });

    it('picking Standard writes it to the pending record (the first message carries it)', () => {
        render();
        act(() => menu().context!.onChange('standard'));
        expect(pending.onMode).toHaveBeenLastCalledWith('contextMode', 'standard');
        pending.contextMode = 'standard';
        render();
        expect(menu().context!.value).toBe('standard');
    });

    it('an account default of Standard is the selected row', () => {
        mocks.settings.agentDefaultOverrides = { codex: { contextMode: 'standard' } };
        render();
        expect(menu().context!.value).toBe('standard');
    });

    it('no row when the model cannot run larger', () => {
        pending.modelMode = 'gpt-5.5';
        render();
        expect(menu().context).toBeUndefined();
    });

    it('no row, no error with an old CLI (catalog without a window table)', () => {
        pending.launcher = launcher({});
        render();
        expect(menu().context).toBeUndefined();
    });

    it('no row, no error when the machine has no catalog', () => {
        pending.launcher = launcher(null);
        render();
        expect(menu().context).toBeUndefined();
    });
});
