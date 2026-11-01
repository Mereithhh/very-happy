import { describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

installBrowserTestGlobals();
const { withLegacyTest } = await import('./MachineAccounts');

describe('B-850c legacy (providers.json) accounts', () => {
    const legacy = { id: 'llmhub', label: 'LLM Hub', agent: 'claude', kind: 'claude-api', status: 'unverified', legacy: true };
    it('show the last test result — the daemon keeps them unverified (wire v2)', () => {
        expect(withLegacyTest(legacy, { ...legacy, status: 'ok', checkedAt: 5 })).toMatchObject({ status: 'ok', checkedAt: 5 });
        expect(withLegacyTest(legacy, undefined).status).toBe('unverified');
        const stored = { ...legacy, legacy: undefined, status: 'invalid' };
        expect(withLegacyTest(stored, { ...legacy, status: 'ok' }).status).toBe('invalid');
    });
});
