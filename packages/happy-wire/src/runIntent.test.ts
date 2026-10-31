import { describe, expect, it } from 'vitest';
import { MessageMetaSchema } from './messageMeta';
import {
    EFFORT_INTENT_AUTO,
    MODEL_INTENT_CONFIG,
    nextRunIntents,
    readEffortIntent,
    readModelIntent,
    reconcileRunPick,
    restoredEffort,
    restoredModel,
    RunIntentRequestSchema,
} from './runIntent';

const NONE = { modelIntent: null, effortIntent: null };

describe('readModelIntent / readEffortIntent (whitelist, AGENTS #14)', () => {
    it('keeps the vocabulary and model ids, 1M suffix included', () => {
        expect(readModelIntent('latest')).toBe('latest');
        expect(readModelIntent('default')).toBe('default');
        expect(readModelIntent('claude-haiku-5-5')).toBe('claude-haiku-5-5');
        expect(readModelIntent('claude-opus-5-5[1m]')).toBe('claude-opus-5-5[1m]');
        expect(readModelIntent('openrouter/gpt-5.6-sol')).toBe('openrouter/gpt-5.6-sol');
        expect(readModelIntent(null)).toBeNull();
    });
    it('drops garbage instead of trusting it', () => {
        expect(readModelIntent('')).toBeUndefined();
        expect(readModelIntent('a b')).toBeUndefined();
        expect(readModelIntent('x'.repeat(200))).toBeUndefined();
        expect(readModelIntent(42)).toBeUndefined();
        expect(readEffortIntent('XHIGH')).toBeUndefined();
        expect(readEffortIntent('xhigh')).toBe('xhigh');
        expect(readEffortIntent(null)).toBeNull();
    });
});

describe('nextRunIntents', () => {
    it('records the explicit intent the Web sends', () => {
        expect(nextRunIntents(NONE, { model: 'claude-opus-5-5', modelIntent: 'latest', effort: null, effortIntent: 'default' }))
            .toEqual({ modelIntent: 'latest', effortIntent: 'default' });
    });
    it('an older Web (model/effort only) still records what it set', () => {
        expect(nextRunIntents(NONE, { model: 'claude-haiku-5-5', effort: 'low' })).toEqual({ modelIntent: 'claude-haiku-5-5', effortIntent: 'low' });
        expect(nextRunIntents(NONE, { model: null, effort: null })).toEqual({ modelIntent: MODEL_INTENT_CONFIG, effortIntent: EFFORT_INTENT_AUTO });
    });
    it('absent keys leave the intent alone (CLI send, team wake)', () => {
        const current = { modelIntent: 'claude-haiku-5-5', effortIntent: 'high' };
        expect(nextRunIntents(current, { sentFrom: 'cli' })).toEqual(current);
        expect(nextRunIntents(current, undefined)).toEqual(current);
    });
    it('a garbage intent falls back to the model it came with', () => {
        expect(nextRunIntents(NONE, { model: 'claude-haiku-5-5', modelIntent: 'bad value' }).modelIntent).toBe('claude-haiku-5-5');
    });
});

describe('restore on resume (QA23b P2-1)', () => {
    it('effort: intent wins, auto is null, nothing recorded is undefined', () => {
        expect(restoredEffort({ effortIntent: 'xhigh', currentThoughtLevelCode: 'medium' })).toBe('xhigh');
        expect(restoredEffort({ effortIntent: 'default' })).toBeNull();
        expect(restoredEffort({})).toBeUndefined();
    });
    it('effort: an older previous wrapper — only Codex trusts the level it reported', () => {
        expect(restoredEffort({ currentThoughtLevelCode: 'xhigh' })).toBeUndefined();
        expect(restoredEffort({ currentThoughtLevelCode: 'xhigh' }, { useReportedLevel: true })).toBe('xhigh');
    });
    it('model: sticky model, else fixed intent, config = null, latest alone = nothing', () => {
        expect(restoredModel({ stickyModel: 'claude-opus-5-5', modelIntent: 'latest' })).toBe('claude-opus-5-5');
        expect(restoredModel({ modelIntent: 'claude-haiku-5-5' })).toBe('claude-haiku-5-5');
        expect(restoredModel({ modelIntent: 'default' })).toBeNull();
        expect(restoredModel({ modelIntent: 'latest' })).toBeUndefined();
        expect(restoredModel({})).toBeUndefined();
    });
});

describe('reconcileRunPick (cross-device rule)', () => {
    it('older wrapper: the local pick as before', () => {
        expect(reconcileRunPick({ local: 'claude-haiku-5-5', base: undefined, intent: undefined })).toEqual({ value: 'claude-haiku-5-5', state: 'local' });
    });
    it('another device opens the session: the session intent, never the account default', () => {
        expect(reconcileRunPick({ local: undefined, base: undefined, intent: 'claude-haiku-5-5' })).toEqual({ value: 'claude-haiku-5-5', state: 'session' });
    });
    it('echoed pick is confirmed', () => {
        expect(reconcileRunPick({ local: 'claude-opus-5-5', base: 'claude-haiku-5-5', intent: 'claude-opus-5-5' }).state).toBe('session');
    });
    it('unsent pick stays pending while the session intent has not moved', () => {
        expect(reconcileRunPick({ local: 'claude-opus-5-5', base: 'claude-haiku-5-5', intent: 'claude-haiku-5-5' })).toEqual({ value: 'claude-opus-5-5', state: 'pending' });
    });
    it('a later choice from another device supersedes the unsent local pick', () => {
        expect(reconcileRunPick({ local: 'claude-opus-5-5', base: 'claude-haiku-5-5', intent: 'claude-sonnet-5-5' })).toEqual({ value: 'claude-sonnet-5-5', state: 'superseded' });
    });
    it('nothing recorded yet: a local pick (even pre-upgrade) is pending', () => {
        expect(reconcileRunPick({ local: 'claude-haiku-5-5', base: undefined, intent: null })).toEqual({ value: 'claude-haiku-5-5', state: 'pending' });
        expect(reconcileRunPick({ local: undefined, base: undefined, intent: null })).toEqual({ value: null, state: 'session' });
    });
});

describe('wire schemas', () => {
    it('message meta carries the intents; unknown values never drop the message', () => {
        expect(MessageMetaSchema.parse({ model: 'x', modelIntent: 'latest', effortIntent: 'whatever' })).toMatchObject({ modelIntent: 'latest', effortIntent: 'whatever' });
    });
    it('RPC params', () => {
        expect(RunIntentRequestSchema.safeParse({ modelIntent: 'latest', model: 'claude-opus-5-5', effortIntent: 'default', effort: null }).success).toBe(true);
        expect(RunIntentRequestSchema.safeParse({ model: 5 }).success).toBe(false);
    });
});
