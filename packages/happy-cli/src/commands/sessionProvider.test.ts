import { describe, expect, it } from 'vitest';
import { parseProvidersFile } from '@/claude/providerBinding';
import { parseSessionProviderArgs, resolveBindingRequest } from './sessionProvider';

describe('B-794 session provider command', () => {
    it('parses list / set / clear', () => {
        expect(parseSessionProviderArgs(['--list'])).toEqual({ action: 'list' });
        expect(parseSessionProviderArgs(['s1', 'llmhub', '--model', 'kimi-k3'])).toEqual({ action: 'set', sessionId: 's1', profile: 'llmhub', model: 'kimi-k3', restart: true });
        expect(parseSessionProviderArgs(['s1', 'default', '--no-restart'])).toEqual({ action: 'clear', sessionId: 's1', restart: false });
        expect(() => parseSessionProviderArgs(['s1'])).toThrow();
        expect(() => parseSessionProviderArgs(['s1', 'default', '--model', 'x'])).toThrow();
    });
    it('validates profile and model', () => {
        const p = parseProvidersFile({ profiles: { hub: { baseUrl: 'https://h', apiKeyFile: 'k', models: ['a', 'b'] } } });
        expect(resolveBindingRequest(p, 'hub', undefined)).toEqual({ profile: 'hub', model: 'a' });
        expect(resolveBindingRequest(p, 'hub', 'b')).toEqual({ profile: 'hub', model: 'b' });
        expect(() => resolveBindingRequest(p, 'hub', 'c')).toThrow(/not in profile/);
        expect(() => resolveBindingRequest(p, 'x', undefined)).toThrow(/unknown provider/);
    });
});
