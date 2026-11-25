import { describe, expect, it } from 'vitest';
import { resolveMessageModeMeta } from './messageMeta';
import { resetRunPickBasesForTests } from './runPicks';

const codexSession = (metadata: Record<string, unknown>, contextMode?: string | null) => ({
    id: 's1',
    permissionMode: 'yolo',
    modelMode: null,
    effortLevel: null,
    contextMode: contextMode ?? null,
    metadata: {
        flavor: 'codex',
        capabilities: ['codex-context-mode-v1'],
        currentModelCode: 'gpt-6.2-astra',
        codexContextMode: 'standard',
        codexContextWindows: { 'gpt-6.2-astra': { standard: 258400, extended: 828400 } },
        models: [{ code: 'gpt-6.2-astra', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] }],
        ...metadata,
    },
}) as unknown as Parameters<typeof resolveMessageModeMeta>[0];

describe('B-977 meta.codexContext', () => {
    it('sends the mode a session with an extendable model runs', () => {
        expect(resolveMessageModeMeta(codexSession({})).codexContext).toBe('standard');
        expect(resolveMessageModeMeta(codexSession({ codexContextMode: 'extended' })).codexContext).toBe('extended');
        expect(resolveMessageModeMeta(codexSession({ codexContextMode: undefined }, 'extended')).codexContext).toBe('extended');
    });

    it('sends nothing for a model with one window, an older wrapper, or another agent', () => {
        expect(resolveMessageModeMeta(codexSession({ currentModelCode: 'gpt-5.5' })).codexContext).toBeUndefined();
        expect(resolveMessageModeMeta(codexSession({ codexContextWindows: undefined, codexContextMode: undefined }, 'extended')).codexContext).toBeUndefined();
        expect(resolveMessageModeMeta({ ...codexSession({}), metadata: { ...codexSession({}).metadata, flavor: 'claude' } } as unknown as Parameters<typeof resolveMessageModeMeta>[0]).codexContext).toBeUndefined();
    });

    it('the account default applies when the session has no report', () => {
        const session = { ...codexSession({ codexContextMode: undefined }), modelMode: 'gpt-6.2-astra' };
        expect(resolveMessageModeMeta(session, { agentDefaultOverrides: { codex: { contextMode: 'extended' } } }).codexContext).toBe('extended');
    });
});

describe('B-977d meta.codexContext carries the pick', () => {
    const birth = { codexContextMode: 'extended', currentModelCode: undefined, codexThreadId: undefined };
    const withModel = (s: Parameters<typeof resolveMessageModeMeta>[0]) => ({ ...s, modelMode: 'gpt-6.2-astra' });

    it('first message of a new session: the draft pick, not the wrapper birth default', () => {
        resetRunPickBasesForTests({});
        expect(resolveMessageModeMeta(withModel(codexSession(birth, 'standard'))).codexContext).toBe('standard');
    });

    it('first message with no pick: the account default', () => {
        resetRunPickBasesForTests({});
        expect(resolveMessageModeMeta(withModel(codexSession(birth)), { agentDefaultOverrides: { codex: { contextMode: 'standard' } } }).codexContext).toBe('standard');
        expect(resolveMessageModeMeta(withModel(codexSession(birth))).codexContext).toBe('extended');
    });

    it('a pick made in a running session (base = the report then) is sent over the report', () => {
        resetRunPickBasesForTests({ s1: { c: 'extended' } });
        expect(resolveMessageModeMeta(codexSession({ codexContextMode: 'extended', codexThreadId: 'th-1' }, 'standard')).codexContext).toBe('standard');
        resetRunPickBasesForTests({ s1: { c: 'standard' } });
        expect(resolveMessageModeMeta(codexSession({ codexContextMode: 'standard', codexThreadId: 'th-1' }, 'extended')).codexContext).toBe('extended');
        resetRunPickBasesForTests(null);
    });
});

describe('B-977d a session that has not run a turn yet', () => {
    // Spawned, no turn: no currentModelCode; the machine config names the model.
    const fresh = { codexContextMode: 'extended', currentModelCode: undefined, codexThreadId: undefined, configuredModel: 'gpt-6.2-astra', defaultModelCode: 'gpt-6.2-astra' };
    it('still sends codexContext (account default 「标准」 reaches the first turn)', () => {
        resetRunPickBasesForTests({});
        expect(resolveMessageModeMeta(codexSession(fresh), { agentDefaultOverrides: { codex: { contextMode: 'standard' } } }).codexContext).toBe('standard');
        expect(resolveMessageModeMeta(codexSession(fresh)).codexContext).toBe('extended');
        expect(resolveMessageModeMeta(codexSession({ ...fresh, configuredModel: 'gpt-5.5', defaultModelCode: 'gpt-5.5' })).codexContext).toBeUndefined();
        resetRunPickBasesForTests(null);
    });
});

describe('B-977d first message before the wrapper published its window table', () => {
    const early = { codexContextMode: 'extended', currentModelCode: undefined, codexThreadId: undefined, codexContextWindows: undefined, models: undefined };
    it('sends the draft pick or the account default; nothing when nothing was chosen', () => {
        resetRunPickBasesForTests({});
        expect(resolveMessageModeMeta(codexSession(early, 'standard')).codexContext).toBe('standard');
        expect(resolveMessageModeMeta(codexSession(early), { agentDefaultOverrides: { codex: { contextMode: 'standard' } } }).codexContext).toBe('standard');
        expect(resolveMessageModeMeta(codexSession(early)).codexContext).toBeUndefined();
        // Older wrapper (no report, no table): nothing.
        expect(resolveMessageModeMeta(codexSession({ ...early, codexContextMode: undefined }, 'standard')).codexContext).toBeUndefined();
        resetRunPickBasesForTests(null);
    });
});
