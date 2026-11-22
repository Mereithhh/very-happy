/** B-957: a DeepSeek Harness account's optional Base URL (gateway) in the Web. */
import { describe, expect, it } from 'vitest';
import { accountAddressFailed, dshAddFields, isValidDshBaseUrl, machineTakesDshBaseUrl, type AgentProfileSummary } from '@/sync/agentProfiles';
import { accountStatusText, accountTestFailureText } from './accountText';

const GW = 'https://your-gateway.example.com';
const t = ((key: string) => key) as unknown as Parameters<typeof accountStatusText>[2];
const account = (extra: Partial<AgentProfileSummary>): AgentProfileSummary => ({ id: 'gw', label: 'GW', agent: 'dsh', kind: 'dsh-api', status: 'ok', ...extra });

describe('B-957 DeepSeek account Base URL', () => {
    it('accepts an http(s) root; refuses a query, fragment, credentials or another scheme (as dsh does)', () => {
        expect(isValidDshBaseUrl(GW)).toBe(true);
        expect(isValidDshBaseUrl(`${GW}/anthropic`)).toBe(true);
        expect(isValidDshBaseUrl(' http://10.0.0.5:8080 ')).toBe(true);
        for (const bad of ['', 'your-gateway.example.com', 'ftp://example.com', `${GW}/?k=1`, `${GW}/#x`, 'https://u:p@example.com']) {
            expect(isValidDshBaseUrl(bad)).toBe(false);
        }
    });

    it('offers the field only on a daemon that keeps it (an older one would drop it silently)', () => {
        expect(machineTakesDshBaseUrl({ features: ['launch-accounts', 'dsh-base-url'] })).toBe(true);
        expect(machineTakesDshBaseUrl({ features: ['launch-accounts'] })).toBe(false);
        expect(machineTakesDshBaseUrl(null)).toBe(false);
    });

    it('the add request: Base URL optional, trimmed, and never sent when the daemon cannot keep it', () => {
        expect(dshAddFields({ label: ' DS ', baseUrl: '', withBaseUrl: true })).toEqual({ label: 'DS' });
        expect(dshAddFields({ label: 'GW', baseUrl: ` ${GW}/ `, withBaseUrl: true })).toEqual({ label: 'GW', baseUrl: GW });
        expect(dshAddFields({ label: 'GW', baseUrl: GW, withBaseUrl: false })).toEqual({ label: 'GW' });
        expect(dshAddFields({ label: 'GW', baseUrl: `${GW}?x=1`, withBaseUrl: true })).toBeNull();
        expect(dshAddFields({ label: ' ', baseUrl: '', withBaseUrl: true })).toBeNull();
    });

    it('a failed test says whether the key or the address is wrong, with the HTTP code', () => {
        const rejected = account({ status: 'invalid', statusDetail: 'HTTP 401', baseUrl: GW });
        expect(accountTestFailureText(rejected, 'invalid', t)).toBe('accounts.statusInvalid · HTTP 401');
        const nowhere = account({ status: 'unverified', statusReason: 'unreachable', statusDetail: 'HTTP 404', baseUrl: GW });
        expect(accountAddressFailed(nowhere)).toBe(true);
        expect(accountStatusText('unverified', nowhere, t)).toBe('accounts.statusUnreachable');
        expect(accountTestFailureText(nowhere, 'unverified', t)).toBe('accounts.statusUnreachable · HTTP 404');
        // Any other failure (5xx, an old daemon without statusReason) stays 「未验证」.
        const flaky = account({ status: 'unverified', statusDetail: 'HTTP 502' });
        expect(accountAddressFailed(flaky)).toBe(false);
        expect(accountTestFailureText(flaky, 'unverified', t)).toBe('accounts.statusUnverified · HTTP 502');
        expect(accountTestFailureText(account({ status: 'invalid' }), 'invalid', t)).toBe('accounts.statusInvalid');
    });
});
