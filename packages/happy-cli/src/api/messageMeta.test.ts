import { describe, expect, it } from 'vitest';
import { MessageMetaSchema } from './types';

describe('CLI MessageMetaSchema delivery', () => {
    it('does not strip the Web Steer marker', () => {
        expect(MessageMetaSchema.parse({ sentFrom: 'web', delivery: 'steer' })).toEqual({
            sentFrom: 'web',
            delivery: 'steer',
        });
    });
});

describe('CLI MessageMetaSchema mode fields', () => {
    /**
     * REGRESSION: `effort` was missing from this schema, so zod stripped it and
     * runClaude's `meta.hasOwnProperty('effort')` was never true — the web's
     * effort/thinking-depth selector had no effect on any released CLI.
     */
    it('carries effort through, including the null "reset to default" form', () => {
        expect(MessageMetaSchema.parse({ sentFrom: 'web', effort: 'high' }).effort).toBe('high');
        expect(MessageMetaSchema.parse({ sentFrom: 'web', effort: null }).effort).toBeNull();
        expect('effort' in MessageMetaSchema.parse({ sentFrom: 'web' })).toBe(false);
    });

    it('keeps effort a plain string so an unknown value cannot reject the whole message', () => {
        // AGENTS 铁律 14: an enum here would make a value the CLI does not know
        // (the `dontAsk` shape) drop the entire user message. runClaude
        // validates against its own allow-list and ignores anything else.
        const parsed = MessageMetaSchema.safeParse({ sentFrom: 'web', effort: 'ludicrous', model: 'opus' });
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.model).toBe('opus');
    });

    it('carries model, including the null "machine default" form (B-103)', () => {
        expect(MessageMetaSchema.parse({ model: 'opus[1m]' }).model).toBe('opus[1m]');
        expect(MessageMetaSchema.parse({ model: null }).model).toBeNull();
    });
});
