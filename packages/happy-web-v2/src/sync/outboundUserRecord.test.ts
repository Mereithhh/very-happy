import { describe, expect, it } from 'vitest';
import { buildOutboundUserRecord, readOutboundUserRecord } from './outboundUserRecord';

describe('B-509 outbound user record', () => {
    it('a queued prompt is the plain user record: no queuedAt, no delivery, mode meta carried', () => {
        const record = buildOutboundUserRecord({ text: 'hi', sentFrom: 'web', appendSystemPrompt: 'sys', modeMeta: { permissionMode: 'plan', model: null, effort: 'high' } });
        expect(record).toEqual({
            role: 'user',
            content: { type: 'text', text: 'hi' },
            meta: { sentFrom: 'web', appendSystemPrompt: 'sys', permissionMode: 'plan', model: null, effort: 'high' },
        });
        expect(readOutboundUserRecord(record)).toEqual({ text: 'hi', modeMeta: { permissionMode: 'plan', model: null, effort: 'high' } });
    });

    it('a live send keeps its steer / queuedAt / displayText stamps exactly as before', () => {
        const record = buildOutboundUserRecord({ text: 'go', sentFrom: 'web', modeMeta: {}, delivery: 'steer', displayText: 'shown', queuedAt: 5 });
        expect(record.meta).toEqual({ sentFrom: 'web', delivery: 'steer', displayText: 'shown', queuedAt: 5 });
        expect(buildOutboundUserRecord({ text: 'go', sentFrom: 'web', modeMeta: {}, delivery: 'queue' }).meta).toEqual({ sentFrom: 'web' });
    });

    it('reading rejects anything that is not a user text record', () => {
        expect(readOutboundUserRecord(null)).toBeNull();
        expect(readOutboundUserRecord({ role: 'agent', content: { type: 'text', text: 'x' } })).toBeNull();
        expect(readOutboundUserRecord({ role: 'user', content: { type: 'text', text: 'x' } })).toEqual({ text: 'x', modeMeta: {} });
    });
});

describe('B-977d Codex 「上下文」 rides the message', () => {
    it('meta.codexContext is written and read back; absent when not chosen', () => {
        const record = buildOutboundUserRecord({ text: 'hi', sentFrom: 'web', modeMeta: { codexContext: 'standard' } });
        expect((record.meta as Record<string, unknown>).codexContext).toBe('standard');
        expect(readOutboundUserRecord(record)?.modeMeta.codexContext).toBe('standard');
        const plain = buildOutboundUserRecord({ text: 'hi', sentFrom: 'web', modeMeta: {} });
        expect('codexContext' in (plain.meta as Record<string, unknown>)).toBe(false);
    });
});
