import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUN_INTENT_CAPABILITY } from '@slopus/happy-wire';
import { codexEffortDowngrade, resolveMessageModeMeta } from './messageMeta';
import { resetRunPickBasesForTests, resolveRunPick } from './runPicks';

const SOL = { code: 'gpt-6-sol', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'medium' };
const G55 = { code: 'gpt-5.5', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'medium' };
/** What a Codex wrapper publishes at birth, before any turn. */
const born = (metadata: Record<string, unknown> = {}, local: Record<string, unknown> = {}) => ({
    id: 'c1', permissionMode: null, modelMode: null, effortLevel: null, presence: 'online' as const, ...local,
    metadata: {
        flavor: 'codex', path: '/w', host: 'h', capabilities: [RUN_INTENT_CAPABILITY], models: [SOL, G55],
        defaultModelCode: 'gpt-6-sol', configuredModel: 'gpt-6-sol', stickyModel: null,
        modelIntent: null, effortIntent: null, currentThoughtLevelCode: 'medium', ...metadata,
    },
}) as any;
const account = (over: Record<string, unknown> = {}) => ({ agentDefaultOverrides: { codex: { effortLevel: 'max', ...over } } }) as any;
const send = (session: any, settings = account()) => resolveMessageModeMeta(session, settings, null);

beforeEach(() => resetRunPickBasesForTests({}));
afterEach(() => resetRunPickBasesForTests(null));

describe('B-975: a fresh Codex session takes the account effort, not the wrapper birth level', () => {
    it('the first message is sent at max, on the default model and on gpt-6-sol', () => {
        expect(send(born())).toMatchObject({ effort: 'max', effortIntent: 'max' });
        expect(send(born(), account({ modelMode: 'gpt-6-sol' }))).toMatchObject({ model: 'gpt-6-sol', effort: 'max', effortIntent: 'max' });
        expect(resolveRunPick(born(), 'effort')).toEqual({ value: undefined, state: 'none' });
    });
    it('the same on an older wrapper that records no intent', () => {
        expect(send(born({ capabilities: [], modelIntent: undefined, effortIntent: undefined })).effort).toBe('max');
    });
    it('a session that ran, or was set to a level, keeps it', () => {
        expect(send(born({ codexThreadId: 't' })).effort).toBe('medium');
        expect(send(born({ currentThoughtLevelCode: 'high' })).effort).toBe('high');
        expect(send(born({ effortIntent: 'medium' })).effort).toBe('medium');
        expect(send(born({}, { effortLevel: 'low' })).effort).toBe('low');
    });
    it('once the wrapper echoed max, later messages stay max (a resume restores the intent)', () => {
        const after = born({ effortIntent: 'max', currentThoughtLevelCode: 'max', codexThreadId: 't', currentModelCode: 'gpt-6-sol' });
        expect(send(after).effort).toBe('max');
        expect(codexEffortDowngrade(after, account(), null)).toBeNull();
    });
    it('no account effort: nothing is sent', () => {
        expect('effort' in send(born(), {} as any)).toBe(false);
    });
    it('no catalog yet on a recording wrapper: the level goes as chosen, Codex judges it', () => {
        expect(send(born({ models: undefined, defaultModelCode: undefined })).effort).toBe('max');
    });
});

describe('B-975: a level the model cannot run is reported before the send', () => {
    it('an account default and a session pick', () => {
        expect(codexEffortDowngrade(born({}, { modelMode: 'gpt-5.5' }), account(), null)).toEqual({ requested: 'max', actual: 'medium' });
        expect(codexEffortDowngrade(born({}, { modelMode: 'gpt-5.5', effortLevel: 'max' }), {} as any, null)).toEqual({ requested: 'max', actual: 'medium' });
    });
    it('a recorded max after the model changed is settled in the message, and said', () => {
        const s = born({ modelIntent: 'gpt-5.5', effortIntent: 'max', currentThoughtLevelCode: 'max', codexThreadId: 't', currentModelCode: 'gpt-6-sol' });
        expect(send(s, {} as any)).toMatchObject({ effort: 'medium', effortIntent: 'medium' });
        expect(codexEffortDowngrade(s, {} as any, null)).toEqual({ requested: 'max', actual: 'medium' });
    });
    it('a recorded max on a thread already on the weaker model is settled here, not silently by the wrapper', () => {
        const s = born({ modelIntent: 'gpt-5.5', effortIntent: 'max', currentThoughtLevelCode: 'max', codexThreadId: 't', currentModelCode: 'gpt-5.5' });
        expect(send(s, {} as any)).toMatchObject({ effort: 'medium', effortIntent: 'medium' });
        expect(codexEffortDowngrade(s, {} as any, null)).toEqual({ requested: 'max', actual: 'medium' });
    });
    it('a model listed with no levels has nothing to choose: no notice, no hold', () => {
        const bare = born({ models: [{ code: 'house-model', reasoningEfforts: [] }], defaultModelCode: 'house-model' });
        expect(send(bare).effort).toBeNull();
        expect(codexEffortDowngrade(bare, account(), null)).toBeNull();
    });
    it('silent when supported, when nothing was chosen, and for other agents', () => {
        expect(codexEffortDowngrade(born(), account(), null)).toBeNull();
        expect(codexEffortDowngrade(born(), {} as any, null)).toBeNull();
        expect(codexEffortDowngrade(born({ flavor: 'claude' }), account(), null)).toBeNull();
    });
});
