import { describe, expect, it } from 'vitest';
import { formatAccountLine, parseAccountArgs } from './account';

describe('B-850a very-happy account', () => {
    it('parses every subcommand', () => {
        expect(parseAccountArgs([])).toEqual({ action: 'help' });
        expect(parseAccountArgs(['ls', '--json'])).toEqual({ action: 'list', json: true });
        expect(parseAccountArgs(['login', '--label', 'Org A'])).toEqual({ action: 'login', label: 'Org A', tokenStdin: false });
        expect(parseAccountArgs(['login', 'org-a'])).toEqual({ action: 'login', accountId: 'org-a', tokenStdin: false });
        expect(parseAccountArgs(['login', '--label=X', '--token-stdin'])).toEqual({ action: 'login', label: 'X', tokenStdin: true });
        expect(parseAccountArgs(['add', '--label', 'Hub', '--base-url', 'https://h', '--key-file', '~/k', '--model', 'kimi:262144', '--model', 'ds'])).toEqual({
            action: 'add', label: 'Hub', baseUrl: 'https://h', key: { source: 'file', path: '~/k' }, models: [{ id: 'kimi', contextWindow: 262144 }, 'ds'],
        });
        expect(parseAccountArgs(['add', '--label', 'H', '--base-url', 'https://h', '--key-env', 'HUB'])).toMatchObject({ key: { source: 'env', name: 'HUB' } });
        expect(parseAccountArgs(['rm', 'x', '--force'])).toEqual({ action: 'rm', accountId: 'x', force: true });
        expect(parseAccountArgs(['default', 'machine'])).toEqual({ action: 'default', accountId: null });
        expect(parseAccountArgs(['bind', 's1', 'hub', '--model', 'kimi', '--no-restart'])).toEqual({ action: 'bind', sessionId: 's1', accountId: 'hub', model: 'kimi', restart: false });
        expect(parseAccountArgs(['bind', 's1', 'machine'])).toEqual({ action: 'bind', sessionId: 's1', accountId: null, restart: true });
        expect(parseAccountArgs(['rename', 'x', 'New name'])).toEqual({ action: 'rename', accountId: 'x', label: 'New name' });
    });
    it('rejects malformed input', () => {
        expect(() => parseAccountArgs(['login'])).toThrow(/--label/);
        expect(() => parseAccountArgs(['add', '--label', 'H', '--base-url', 'https://h'])).toThrow(/exactly one/);
        expect(() => parseAccountArgs(['add', '--label', 'H', '--base-url', 'https://h', '--key-file', 'a', '--key-stdin'])).toThrow(/exactly one/);
        expect(() => parseAccountArgs(['rm'])).toThrow();
        expect(() => parseAccountArgs(['list', '--bogus'])).toThrow(/unknown option/);
        expect(() => parseAccountArgs(['frobnicate'])).toThrow(/unknown account command/);
    });
    it('list line shows status and key reference, never a secret', () => {
        const line = formatAccountLine({ id: 'hub', label: 'Hub', agent: 'claude', kind: 'claude-api', status: 'ok', baseUrl: 'https://h', models: ['kimi'], keySource: 'file', keyRef: '~/k' }, true, 0);
        expect(line).toBe('* hub  Hub  [api]  ok  — https://h · models: kimi · key: file ~/k');
        const sub = formatAccountLine({ id: 'a', label: 'A', agent: 'claude', kind: 'claude-subscription', status: 'ok', expiresAt: 10 * 86_400_000 }, false, 0);
        expect(sub).toContain('(soon)');
    });
});
