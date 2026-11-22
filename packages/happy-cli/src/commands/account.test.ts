import { describe, expect, it } from 'vitest';
import { formatAccountLine, parseAccountArgs } from './account';

describe('B-850a very-happy account', () => {
    it('parses every subcommand', () => {
        expect(parseAccountArgs([])).toEqual({ action: 'help' });
        expect(parseAccountArgs(['ls', '--json'])).toEqual({ action: 'list', json: true });
        expect(parseAccountArgs(['login', '--label', 'Org A'])).toEqual({ action: 'login', agent: 'claude', label: 'Org A', tokenStdin: false });
        expect(parseAccountArgs(['login', 'org-a'])).toEqual({ action: 'login', agent: 'claude', accountId: 'org-a', tokenStdin: false });
        expect(parseAccountArgs(['login', '--label=X', '--token-stdin'])).toEqual({ action: 'login', agent: 'claude', label: 'X', tokenStdin: true });
        expect(parseAccountArgs(['add', '--label', 'Hub', '--base-url', 'https://h', '--key-file', '~/k', '--model', 'kimi:262144', '--model', 'ds'])).toEqual({
            action: 'add', agent: 'claude', label: 'Hub', baseUrl: 'https://h', key: { source: 'file', path: '~/k' }, models: [{ id: 'kimi', contextWindow: 262144 }, 'ds'],
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

describe('B-957 account add --agent dsh / edit', () => {
    it('parses a DeepSeek Harness account with an optional --base-url', () => {
        expect(parseAccountArgs(['add', '--agent', 'dsh', '--label', 'DS', '--key-env', 'DEEPSEEK_API_KEY'])).toEqual({
            action: 'add', agent: 'dsh', label: 'DS', key: { source: 'env', name: 'DEEPSEEK_API_KEY' }, models: [],
        });
        expect(parseAccountArgs(['add', '--agent', 'dsh', '--label', 'GW', '--base-url', 'https://your-gateway.example.com', '--key-stdin'])).toMatchObject({
            agent: 'dsh', baseUrl: 'https://your-gateway.example.com', key: { source: 'stdin' },
        });
        expect(() => parseAccountArgs(['add', '--agent', 'dsh', '--key-stdin'])).toThrow(/--label/);
        expect(() => parseAccountArgs(['add', '--agent', 'dsh', '--label', 'x', '--model', 'm', '--key-stdin'])).toThrow(/--model/);
        expect(() => parseAccountArgs(['add', '--agent', 'dsh', '--label', 'x', '--provider', 'p', '--key-stdin'])).toThrow(/Codex/);
        expect(() => parseAccountArgs(['login', '--agent', 'dsh'])).toThrow(/--agent/);
    });

    it('edit takes exactly one of --base-url / --no-base-url', () => {
        expect(parseAccountArgs(['edit', 'gw', '--base-url', 'https://your-gateway.example.com'])).toEqual({ action: 'edit', accountId: 'gw', baseUrl: 'https://your-gateway.example.com' });
        expect(parseAccountArgs(['edit', 'gw', '--no-base-url'])).toEqual({ action: 'edit', accountId: 'gw', baseUrl: null });
        expect(() => parseAccountArgs(['edit', 'gw'])).toThrow(/exactly one/);
        expect(() => parseAccountArgs(['edit', 'gw', '--no-base-url', '--base-url', 'https://x.example.com'])).toThrow(/exactly one/);
        expect(() => parseAccountArgs(['edit', '--no-base-url'])).toThrow(/account id/);
    });

    it('list says when the Base URL, not the key, is the problem', () => {
        const line = formatAccountLine({ id: 'gw', label: 'GW', agent: 'dsh', kind: 'dsh-api', status: 'unverified', statusReason: 'unreachable', statusDetail: 'HTTP 404', baseUrl: 'https://your-gateway.example.com' }, false, 0);
        expect(line).toContain('[deepseek]');
        expect(line).toContain('wrong Base URL or unreachable: HTTP 404');
    });
});
