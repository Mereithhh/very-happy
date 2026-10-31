import { describe, expect, it } from 'vitest';
import { RUN_INTENT_RPC } from '@slopus/happy-wire';
import type { Metadata } from '@/api/types';
import { recordRunIntents, registerRunIntentRpc, withoutEffort, withRunIntents } from './runIntent';

const base = { path: '/w', host: 'h', modelIntent: null, effortIntent: null } as Metadata;

function fakeSession(initial: Metadata) {
    let metadata = initial;
    let writes = 0;
    return {
        getMetadata: () => metadata,
        updateMetadata: (handler: (m: Metadata) => Metadata) => { metadata = handler(metadata); writes += 1; },
        get writes() { return writes; },
        get metadata() { return metadata; },
    };
}

describe('withRunIntents (B-849b)', () => {
    it('records the intent a message carried, with wrapper facts', () => {
        expect(withRunIntents(base, { model: 'claude-opus-5-5', modelIntent: 'latest', effort: 'high' }, { stickyModel: 'claude-opus-5-5' }))
            .toMatchObject({ modelIntent: 'latest', effortIntent: 'high', stickyModel: 'claude-opus-5-5' });
    });
    it('nothing new keeps the object', () => {
        const current = { ...base, modelIntent: 'latest', effortIntent: 'high', stickyModel: 'x' };
        expect(withRunIntents(current, { sentFrom: 'cli' }, { stickyModel: 'x' })).toBe(current);
    });
    it('a previous older wrapper left no fields: the first write adds them', () => {
        const old = { path: '/w', host: 'h' } as Metadata;
        expect(withRunIntents(old, {})).toMatchObject({ modelIntent: null, effortIntent: null });
    });
});

describe('recordRunIntents', () => {
    it('skips the metadata write when nothing changed', () => {
        const session = fakeSession({ ...base, modelIntent: 'latest' });
        recordRunIntents(session, { modelIntent: 'latest' });
        expect(session.writes).toBe(0);
        recordRunIntents(session, { model: 'claude-haiku-5-5', modelIntent: 'claude-haiku-5-5' });
        expect(session.writes).toBe(1);
        expect(session.metadata.modelIntent).toBe('claude-haiku-5-5');
    });
});

describe('session-run-intent RPC', () => {
    it('applies to the wrapper, then records; bad params never touch either', async () => {
        const session = fakeSession(base);
        const handlers = new Map<string, (p: unknown) => unknown>();
        const applied: unknown[] = [];
        registerRunIntentRpc({ registerHandler: (m, h) => handlers.set(m, h) }, session, (request) => {
            applied.push(request);
            return { facts: { stickyModel: request.model ?? null } };
        });
        const rpc = handlers.get(RUN_INTENT_RPC)!;
        expect(await rpc({ modelIntent: 'claude-haiku-5-5', model: 'claude-haiku-5-5', effortIntent: 'low', effort: 'low' }))
            .toEqual({ ok: true, modelIntent: 'claude-haiku-5-5', effortIntent: 'low' });
        expect(session.metadata).toMatchObject({ modelIntent: 'claude-haiku-5-5', effortIntent: 'low', stickyModel: 'claude-haiku-5-5' });
        expect(await rpc({ model: 42 })).toEqual({ ok: false, error: 'invalid-request' });
        expect(applied).toHaveLength(1);
    });
});

describe('refused effort (B-849b2, QA28 P2-4)', () => {
    it('withoutEffort drops only the effort keys', () => {
        expect(withoutEffort({ model: 'gpt-6-astra', modelIntent: 'gpt-6-astra', effort: 'minimal', effortIntent: 'minimal', sentFrom: 'web' }))
            .toEqual({ model: 'gpt-6-astra', modelIntent: 'gpt-6-astra', sentFrom: 'web' });
        expect(withoutEffort(undefined)).toBeUndefined();
    });
    it('the RPC records the model but not a refused effort, and says so', async () => {
        const session = fakeSession({ ...base, modelIntent: 'gpt-5.6-luna', effortIntent: 'xhigh' });
        const handlers = new Map<string, (p: unknown) => unknown>();
        registerRunIntentRpc({ registerHandler: (m, h) => handlers.set(m, h) }, session, () => ({ effortRefused: true }));
        const rpc = handlers.get(RUN_INTENT_RPC)!;
        expect(await rpc({ modelIntent: 'gpt-6-astra', model: 'gpt-6-astra', effortIntent: 'minimal', effort: 'minimal' }))
            .toEqual({ ok: false, error: 'unsupported-effort' });
        expect(session.metadata).toMatchObject({ modelIntent: 'gpt-6-astra', effortIntent: 'xhigh' });
    });
});
