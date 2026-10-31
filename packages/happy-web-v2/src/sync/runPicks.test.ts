import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_INTENT_CAPABILITY, RUN_INTENT_RPC } from '@slopus/happy-wire';
import { pushRunIntent, resetRunPickBasesForTests, resolveRunPick, sessionRunIntents, settledRunPick, withRunPicks } from './runPicks';
import { resolveMessageModeMeta } from './messageMeta';

const CAPS = ['claude-opus-5-5-v1', RUN_INTENT_CAPABILITY];
const claude = (metadata: Record<string, unknown> = {}, local: { modelMode?: string | null; effortLevel?: string | null } = {}, id = 's1') => ({
    id,
    permissionMode: null,
    modelMode: local.modelMode ?? null,
    effortLevel: local.effortLevel ?? null,
    presence: 'online' as const,
    metadata: { flavor: 'claude', path: '/w', host: 'h', capabilities: CAPS, ...metadata } as any,
});
const ACCOUNT_OPUS = { agentDefaultOverrides: { claude: { modelMode: 'claude-opus-5-5', effortLevel: 'low' } } } as any;
const noBase = () => undefined;

beforeEach(() => resetRunPickBasesForTests({}));
afterEach(() => resetRunPickBasesForTests(null));

describe('sessionRunIntents', () => {
    it('older wrapper → undefined; new wrapper without a record yet → null', () => {
        expect(sessionRunIntents({ flavor: 'claude', modelIntent: 'claude-haiku-5-5' })).toEqual({ model: undefined, effort: undefined });
        expect(sessionRunIntents({ capabilities: [RUN_INTENT_CAPABILITY] })).toEqual({ model: null, effort: null });
        expect(sessionRunIntents({ capabilities: [RUN_INTENT_CAPABILITY], modelIntent: 'bad value', effortIntent: 'xhigh' })).toEqual({ model: null, effort: 'xhigh' });
    });
});

describe('cross-device: device B opens a session device A set to Haiku', () => {
    const onB = claude({ modelIntent: 'claude-haiku-5-5', effortIntent: 'xhigh', currentModelCode: 'claude-haiku-5-5' });
    it('shows the session choice, not B\'s account default', () => {
        expect(resolveRunPick(onB, 'model', noBase)).toEqual({ value: 'claude-haiku-5-5', state: 'session' });
        expect(withRunPicks(onB, noBase)).toMatchObject({ modelMode: 'claude-haiku-5-5', effortLevel: 'xhigh' });
    });
    it('and B\'s next message runs Haiku (REGRESSION: it was sent with the account default Opus)', () => {
        const meta = resolveMessageModeMeta(onB, ACCOUNT_OPUS, null);
        expect(meta).toMatchObject({ model: 'claude-haiku-5-5', modelIntent: 'claude-haiku-5-5' });
        // The session's effort, not the account's `low` (Opus runs xhigh).
        const opus = claude({ modelIntent: 'claude-opus-5-5', effortIntent: 'xhigh' });
        expect(resolveMessageModeMeta(opus, ACCOUNT_OPUS, null)).toMatchObject({ effort: 'xhigh', effortIntent: 'xhigh' });
    });
    it('a session following latest stays 「跟随最新」 on every device', () => {
        const meta = resolveMessageModeMeta(claude({ modelIntent: 'latest' }), ACCOUNT_OPUS, null);
        expect(meta.modelIntent).toBe('latest');
        expect(meta.model).toBe('claude-opus-5-5');
    });
    it('「自动」 recorded stays auto even where the account default names a level', () => {
        const meta = resolveMessageModeMeta(claude({ effortIntent: 'default' }), ACCOUNT_OPUS, null);
        expect(meta).toMatchObject({ effort: null, effortIntent: 'default' });
    });
});

describe('concurrent picks: the choice that reaches the wrapper last wins', () => {
    it('an unsent pick on A is pending while the session intent has not moved', () => {
        const a = claude({ modelIntent: 'claude-haiku-5-5' }, { modelMode: 'claude-sonnet-5-5' });
        const base = () => 'claude-haiku-5-5';
        expect(resolveRunPick(a, 'model', base)).toEqual({ value: 'claude-sonnet-5-5', state: 'pending' });
        expect(resolveMessageModeMeta({ ...a }, undefined, null).model).toBe('claude-haiku-5-5'); // no base stored → superseded
    });
    it('B\'s later choice supersedes A\'s unsent pick; A tidies it away', () => {
        const a = claude({ modelIntent: 'claude-opus-5-5' }, { modelMode: 'claude-sonnet-5-5' });
        expect(resolveRunPick(a, 'model', () => 'claude-haiku-5-5')).toEqual({ value: 'claude-opus-5-5', state: 'superseded' });
        expect(settledRunPick(a, 'model')).toBe('clear');
    });
    it('an echoed pick is no longer local', () => {
        expect(settledRunPick(claude({ modelIntent: 'claude-opus-5-5' }, { modelMode: 'claude-opus-5-5' }), 'model')).toBe('clear');
        expect(settledRunPick(claude({ modelIntent: 'claude-opus-5-5' }), 'model')).toBeNull();
    });
    it('a pending pick (base still current) and an older wrapper\'s pick are kept', () => {
        resetRunPickBasesForTests({ s1: { m: 'claude-haiku-5-5' } });
        expect(settledRunPick(claude({ modelIntent: 'claude-haiku-5-5' }, { modelMode: 'claude-sonnet-5-5' }), 'model')).toBeNull();
        expect(settledRunPick(claude({ capabilities: [] }, { modelMode: 'claude-sonnet-5-5' }), 'model')).toBeNull();
    });
});

describe('sessions without an intent (older wrapper / nothing chosen yet)', () => {
    it('older wrapper: this device\'s pick as before', () => {
        const old = claude({ capabilities: ['claude-opus-5-5-v1'], currentModelCode: 'claude-opus-5-5' }, { modelMode: 'claude-haiku-5-5' });
        expect(resolveRunPick(old, 'model', noBase)).toEqual({ value: 'claude-haiku-5-5', state: 'local' });
    });
    it('no pick anywhere: what the session runs, not the account default', () => {
        const old = claude({ capabilities: ['claude-opus-5-5-v1'], currentModelCode: 'claude-sonnet-5-5' });
        expect(resolveRunPick(old, 'model', noBase)).toEqual({ value: 'claude-sonnet-5-5', state: 'fallback' });
        expect(resolveMessageModeMeta(old, ACCOUNT_OPUS, null).model).toBe('claude-sonnet-5-5');
    });
    it('a session that never ran takes the new-session default', () => {
        expect(resolveRunPick(claude(), 'model', noBase)).toEqual({ value: undefined, state: 'none' });
        expect(resolveMessageModeMeta(claude(), ACCOUNT_OPUS, null).model).toBe('claude-opus-5-5');
    });
    it('Codex: the level it reports running beats the account default (QA23b P2-1)', () => {
        const codex = { ...claude(), metadata: { flavor: 'codex', path: '/w', host: 'h', currentThoughtLevelCode: 'xhigh', stickyModel: null } as any };
        expect(resolveRunPick(codex, 'effort', noBase)).toEqual({ value: 'xhigh', state: 'fallback' });
    });
});

describe('pushRunIntent', () => {
    const params = { modelIntent: 'claude-haiku-5-5', model: 'claude-haiku-5-5' };
    it('sends to an online wrapper that records intents', async () => {
        const send = vi.fn(async () => ({ ok: true, modelIntent: 'claude-haiku-5-5', effortIntent: null }));
        expect(await pushRunIntent(claude(), params, send)).toBe(true);
        expect(send).toHaveBeenCalledWith('s1', RUN_INTENT_RPC, params);
    });
    it('never calls an older wrapper or an offline session; an { error } answer is a failure (AGENTS #17)', async () => {
        const send = vi.fn(async () => ({ error: 'RPC method not available' }));
        expect(await pushRunIntent(claude({ capabilities: ['claude-opus-5-5-v1'] }), params, send)).toBe(false);
        expect(await pushRunIntent({ ...claude(), presence: 'offline' as any }, params, send)).toBe(false);
        expect(send).not.toHaveBeenCalled();
        expect(await pushRunIntent(claude(), params, send)).toBe(false);
        expect(await pushRunIntent(claude(), params, async () => { throw new Error('timeout'); })).toBe(false);
    });
});

describe('Codex following latest (no model sent)', () => {
    it('still records 「跟随最新」 as the session choice', () => {
        const codex = { id: 'c1', permissionMode: null, modelMode: null, effortLevel: null,
            metadata: { flavor: 'codex', path: '/w', host: 'h', capabilities: [RUN_INTENT_CAPABILITY], configuredModel: 'gpt-5.6-sol', stickyModel: null } as any };
        const meta = resolveMessageModeMeta(codex, undefined, null);
        expect('model' in meta).toBe(false);
        expect(meta.modelIntent).toBe('latest');
    });
});

describe('a recorded effort the model cannot run is no choice (B-849b2, QA28 P2-4)', () => {
    const ASTRA = { code: 'gpt-6-astra', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };
    const codex = (metadata: Record<string, unknown>) => ({
        id: 'c1', permissionMode: null, modelMode: null, effortLevel: null, presence: 'online' as const,
        metadata: { flavor: 'codex', path: '/w', host: 'h', capabilities: [RUN_INTENT_CAPABILITY], models: [ASTRA], ...metadata } as any,
    });
    it('an intent recorded from a refused message reads as nothing chosen', () => {
        expect(sessionRunIntents(codex({ modelIntent: 'gpt-6-astra', effortIntent: 'minimal' }).metadata)).toEqual({ model: 'gpt-6-astra', effort: null });
        expect(sessionRunIntents(codex({ modelIntent: 'latest', currentModelCode: 'gpt-6-astra', effortIntent: 'minimal' }).metadata).effort).toBeNull();
        expect(sessionRunIntents(codex({ modelIntent: 'gpt-6-astra', effortIntent: 'xhigh' }).metadata).effort).toBe('xhigh');
    });
    it('no verdict without the model in the catalog', () => {
        expect(sessionRunIntents(codex({ modelIntent: 'gpt-6-sol', effortIntent: 'minimal' }).metadata).effort).toBe('minimal');
    });
    it('the reported level is not a fallback either when the model refuses it', () => {
        expect(resolveRunPick(codex({ modelIntent: 'gpt-6-astra', effortIntent: 'minimal', currentModelCode: 'gpt-6-astra', currentThoughtLevelCode: 'minimal' }), 'effort', noBase))
            .toEqual({ value: undefined, state: 'none' });
        expect(resolveRunPick(codex({ modelIntent: 'gpt-6-astra', effortIntent: 'minimal', currentModelCode: 'gpt-6-astra', currentThoughtLevelCode: 'xhigh' }), 'effort', noBase))
            .toEqual({ value: 'xhigh', state: 'fallback' });
    });
});
