import { describe, expect, it } from 'vitest';
import { parseRelayCandidates, relayFeatureConfig } from './relayConfig';

describe('relay config', () => {
    it('normalizes origins and preserves stable candidate order', () => {
        expect(parseRelayCandidates(JSON.stringify([
            { id: 'sin', url: 'https://sin.example.com/', region: 'Singapore' },
            { id: 'usw', url: 'https://us.example.com', region: 'US West' },
        ]))).toEqual([
            { id: 'sin', url: 'https://sin.example.com', region: 'Singapore' },
            { id: 'usw', url: 'https://us.example.com', region: 'US West' },
        ]);
    });

    it('rejects duplicate and non-origin relay URLs', () => {
        expect(() => parseRelayCandidates(JSON.stringify([
            { id: 'same', url: 'https://a.example.com', region: 'a' },
            { id: 'same', url: 'https://b.example.com', region: 'b' },
        ]))).toThrow('duplicate relay id');
        expect(() => parseRelayCandidates(JSON.stringify([
            { id: 'bad', url: 'https://a.example.com/path', region: 'a' },
        ]))).toThrow('origin');
    });

    it('disables an empty list and rejects configured relays without a strong dedicated secret', () => {
        expect(relayFeatureConfig({ HAPPY_RELAYS_JSON: '[]', RELAY_TOKEN_SECRET: 'secret' } as NodeJS.ProcessEnv).enabled).toBe(false);
        expect(() => relayFeatureConfig({ HAPPY_RELAYS_JSON: '[{"id":"sin","url":"https://sin.example.com","region":"sin"}]' } as NodeJS.ProcessEnv)).toThrow('at least 32 bytes');
    });
});
