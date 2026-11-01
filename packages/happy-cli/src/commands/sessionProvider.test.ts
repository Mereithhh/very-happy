import { describe, expect, it } from 'vitest';
import { legacyAccountsFromProviders, mergeAccounts, parseAccountsFile } from '@/agentProfiles/store';
import { parseSessionProviderArgs, resolveBindingRequest } from './sessionProvider';

describe('B-794 session provider command (alias of account bind since B-850a)', () => {
    it('parses list / set / clear', () => {
        expect(parseSessionProviderArgs(['--list'])).toEqual({ action: 'list' });
        expect(parseSessionProviderArgs(['s1', 'llmhub', '--model', 'kimi-k3'])).toEqual({ action: 'set', sessionId: 's1', profile: 'llmhub', model: 'kimi-k3', restart: true });
        expect(parseSessionProviderArgs(['s1', 'default', '--no-restart'])).toEqual({ action: 'clear', sessionId: 's1', restart: false });
        expect(() => parseSessionProviderArgs(['s1'])).toThrow();
        expect(() => parseSessionProviderArgs(['s1', 'default', '--model', 'x'])).toThrow();
    });
    it('validates account and model; providers.json profiles count as accounts', () => {
        const accounts = mergeAccounts(
            parseAccountsFile({ accounts: { orga: { agent: 'claude', kind: 'claude-subscription', label: 'Org A' } } }),
            legacyAccountsFromProviders({ profiles: { hub: { baseUrl: 'https://h', apiKeyFile: 'k', models: ['a', 'b'] } } }),
        );
        expect(resolveBindingRequest(accounts, 'hub', undefined)).toEqual({ account: 'hub', model: 'a' });
        expect(resolveBindingRequest(accounts, 'hub', 'b')).toEqual({ account: 'hub', model: 'b' });
        expect(resolveBindingRequest(accounts, 'orga', undefined)).toEqual({ account: 'orga' });
        expect(() => resolveBindingRequest(accounts, 'orga', 'opus')).toThrow(/API accounts only/);
        expect(() => resolveBindingRequest(accounts, 'hub', 'c')).toThrow(/not in account/);
        expect(() => resolveBindingRequest(accounts, 'x', undefined)).toThrow(/unknown account/);
    });
});
