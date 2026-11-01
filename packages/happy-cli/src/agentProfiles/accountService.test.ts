import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_PROFILE_RPC } from '@slopus/happy-wire';
import { AccountError, AccountService } from './accountService';
import { registerAgentProfileHandlers } from './agentProfileRpc';
import { classifyClaudeCheck, classifyHttpCheck, sanitizeDetail } from './checkAccount';
import { accountSecretPath, readAccountsFileV2, readSessionBindings } from './store';

// Fake credentials, assembled at runtime so secret scanners do not flag test literals.
const OAT = ['sk', 'ant', 'oat01', ''].join('-');

function service(over: Partial<ConstructorParameters<typeof AccountService>[0]> = {}) {
    const home = mkdtempSync(join(tmpdir(), 'vh-b850-svc-'));
    const onChanged = vi.fn();
    const check = vi.fn(async () => ({ status: 'ok', at: 7 }));
    const svc = new AccountService({ home, env: { HUB_KEY: 'k' }, now: () => 5, daemonPid: 99, onChanged, check, ...over });
    return { home, svc, onChanged, check };
}

describe('B-850a account service', () => {
    it('add (paste): key stored 0600 on the machine, never in accounts.json or the summary; checked right away', async () => {
        const { home, svc, onChanged, check } = service();
        const account = await svc.add({ agent: 'claude', kind: 'claude-api', label: 'LLM hub', baseUrl: 'https://hub/', models: ['kimi', { id: 'ds', contextWindow: 128000 }], key: { source: 'paste', value: 'sk-pasted-secret' } });
        expect(account).toMatchObject({ id: 'llm-hub', status: 'ok', keySource: 'stored', models: ['kimi', 'ds'], baseUrl: 'https://hub' });
        expect(JSON.stringify(account)).not.toContain('sk-pasted-secret');
        expect(readFileSync(join(home, 'accounts.json'), 'utf8')).not.toContain('sk-pasted-secret');
        expect(readFileSync(accountSecretPath(home, 'llm-hub'), 'utf8').trim()).toBe('sk-pasted-secret');
        expect(statSync(accountSecretPath(home, 'llm-hub')).mode & 0o777).toBe(0o600);
        expect(check).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://hub' }), 'sk-pasted-secret');
        expect(readAccountsFileV2(home).accounts['llm-hub'].contextWindows).toEqual({ ds: 128000 });
        expect(onChanged).toHaveBeenCalled();
    });

    it('add rejects bad params with a code; a missing key file saves as missing-secret without a check', async () => {
        const { svc, check } = service();
        await expect(svc.add({ agent: 'claude', kind: 'claude-api', label: '', baseUrl: 'ftp://x', key: { source: 'file', path: '/x' } })).rejects.toMatchObject({ code: 'invalid-params' });
        const a = await svc.add({ agent: 'claude', kind: 'claude-api', label: 'Hub', baseUrl: 'https://hub', key: { source: 'file', path: '/nonexistent/key' } });
        expect(a.status).toBe('missing-secret');
        expect(check).not.toHaveBeenCalled();
    });

    it('subscription token store: new account, re-login updates expiry; legacy providers are read-only', async () => {
        const { home, svc } = service();
        writeFileSync(join(home, 'providers.json'), JSON.stringify({ profiles: { hub: { baseUrl: 'https://h', apiKeyFile: '/k' } } }));
        const a = svc.storeSubscriptionToken(OAT + 'T', { label: 'Org A' });
        expect(a).toMatchObject({ id: 'org-a', kind: 'claude-subscription', status: 'ok', expiresAt: 5 + 365 * 86_400_000 });
        expect(() => svc.rename('hub', 'x')).toThrow(AccountError);
        await expect(svc.remove('hub', false)).rejects.toThrow(/providers.json/);
        expect(svc.state().accounts.map((x) => [x.id, x.legacy ?? false])).toEqual([['hub', true], ['org-a', false]]);
    });

    it('remove refuses while sessions use the account; force keeps their binding and restarts them now (they come back unavailable, no fallback)', async () => {
        const restartSession = vi.fn(async (id: string) => (id === 's2' ? { ok: false as const, notRunning: true, error: 'restart-precheck:not-tracked' } : { ok: true as const }));
        const { home, svc } = service({ restartSession });
        svc.storeSubscriptionToken(OAT + 'T', { label: 'Org A' });
        svc.setDefault('claude', 'org-a');
        svc.writeBinding('s1', 'org-a');
        svc.writeBinding('s2', 'org-a');
        await expect(svc.remove('org-a', false)).rejects.toMatchObject({ code: 'in-use', sessions: ['s1', 's2'] });
        expect(restartSession).not.toHaveBeenCalled();
        expect(await svc.remove('org-a', true)).toEqual({ removed: true, sessions: ['s1', 's2'], restarts: { s1: 'done', s2: 'skipped' } });
        expect(restartSession.mock.calls.map((c) => c[0]).sort()).toEqual(['s1', 's2']);
        expect(readSessionBindings(home).s1).toEqual({ account: 'org-a' });
        expect(svc.state().defaults).toEqual({});
        expect(() => statSync(accountSecretPath(home, 'org-a'))).toThrow();
    });

    it('spawn account: default when unspecified, null = machine, unusable = refuse (Q3)', () => {
        const { svc } = service();
        expect(svc.resolveSpawnAccount('claude', undefined)).toBeNull();
        svc.storeSubscriptionToken(OAT + 'T', { label: 'Org A' });
        svc.setDefault('claude', 'org-a');
        expect(svc.resolveSpawnAccount('claude', undefined)).toBe('org-a');
        expect(svc.resolveSpawnAccount('claude', null)).toBeNull();
        expect(() => svc.resolveSpawnAccount('claude', 'gone')).toThrow(/agent-profile-unavailable:missing/);
        const expired = service({ now: () => 5 + 366 * 86_400_000 });
        expired.svc.storeSubscriptionToken('x', { label: 'Old' });
        const later = new AccountService({ home: expired.home, now: () => 5 + 800 * 86_400_000 });
        expect(() => later.resolveSpawnAccount('claude', 'old')).toThrow(/agent-profile-unavailable:expired/);
    });

    it('bind: validates, writes, restarts in place; reports skipped / failed / pending honestly', async () => {
        const restart = vi.fn(async () => ({ ok: true as const }));
        const { home, svc } = service({ restartSession: restart });
        await svc.add({ agent: 'claude', kind: 'claude-api', label: 'Hub', baseUrl: 'https://hub', models: ['kimi'], key: { source: 'env', name: 'HUB_KEY' } });
        await expect(svc.bind({ sessionId: 's1', accountId: 'hub', model: 'gpt' })).rejects.toMatchObject({ code: 'invalid-params' });
        await expect(svc.bind({ sessionId: 's1', accountId: 'nope' })).rejects.toMatchObject({ code: 'not-found' });
        expect(await svc.bind({ sessionId: 's1', accountId: 'hub', model: 'kimi' })).toEqual({ bound: true, restart: 'done' });
        expect(restart).toHaveBeenCalledWith('s1');
        expect(readSessionBindings(home).s1).toEqual({ account: 'hub', model: 'kimi' });
        expect(await svc.bind({ sessionId: 's1', accountId: null, restart: false })).toEqual({ bound: true, restart: 'skipped' });
        expect(readSessionBindings(home).s1).toEqual({ account: null });
        restart.mockResolvedValueOnce({ ok: false, notRunning: true, error: 'not-tracked' } as never);
        expect((await svc.bind({ sessionId: 's2', accountId: 'hub' })).restart).toBe('skipped');
        restart.mockResolvedValueOnce({ ok: false, error: 'restart:limit' } as never);
        expect(await svc.bind({ sessionId: 's3', accountId: 'hub' })).toEqual({ bound: true, restart: 'failed', error: 'restart:limit' });
    });

    it('a restart that fails while the old wrapper still runs rolls the binding back (never bound-but-running-the-old-one)', async () => {
        const restart = vi.fn(async () => ({ ok: true as const }));
        const { home, svc } = service({ restartSession: restart });
        await svc.add({ agent: 'claude', kind: 'claude-api', label: 'Hub', baseUrl: 'https://hub', models: ['kimi'], key: { source: 'env', name: 'HUB_KEY' } });
        await svc.add({ agent: 'claude', kind: 'claude-api', label: 'Hub2', baseUrl: 'https://hub2', models: ['kimi'], key: { source: 'env', name: 'HUB_KEY' } });
        await svc.bind({ sessionId: 's1', accountId: 'hub', model: 'kimi' });
        restart.mockResolvedValueOnce({ ok: false, stillRunning: true, error: 'restart:restart-limit: …' } as never);
        expect(await svc.bind({ sessionId: 's1', accountId: 'hub2' })).toEqual({ bound: false, rolledBack: true, restart: 'failed', error: 'restart:restart-limit: …' });
        expect(readSessionBindings(home).s1).toEqual({ account: 'hub', model: 'kimi' });
        // No previous v2 entry → the entry is removed again (a v1 binding, if any, applies as before).
        restart.mockResolvedValueOnce({ ok: false, stillRunning: true, error: 'x' } as never);
        await svc.bind({ sessionId: 'fresh', accountId: 'hub2' });
        expect(readSessionBindings(home).fresh).toBeUndefined();
        // Stopped but not relaunched → nothing runs on the old credential: the binding stays.
        restart.mockResolvedValueOnce({ ok: false, stillRunning: false, error: 'restart-precheck:cwd-missing' } as never);
        expect(await svc.bind({ sessionId: 's1', accountId: 'hub2' })).toEqual({ bound: true, restart: 'failed', error: 'restart-precheck:cwd-missing' });
        expect(readSessionBindings(home).s1).toEqual({ account: 'hub2' });
    });

    it('RPC: every method registered; failures resolve { error, code } (AGENTS #17)', async () => {
        const { svc } = service();
        const handlers = new Map<string, (p: unknown) => Promise<unknown>>();
        registerAgentProfileHandlers({ registerHandler: ((m: string, h: (p: unknown) => Promise<unknown>) => { handlers.set(m, h); }) as never }, svc);
        expect([...handlers.keys()].sort()).toEqual(Object.values(AGENT_PROFILE_RPC).sort());
        expect(await handlers.get(AGENT_PROFILE_RPC.list)!({})).toMatchObject({ daemonPid: 99, accounts: [], defaults: {} });
        expect(await handlers.get(AGENT_PROFILE_RPC.remove)!({ accountId: 'x' })).toEqual({ error: 'no account "x"', code: 'not-found' });
        expect(await handlers.get(AGENT_PROFILE_RPC.loginStatus)!({ loginId: 'x' })).toMatchObject({ code: 'internal' });
        expect(await handlers.get(AGENT_PROFILE_RPC.setDefault)!({ agent: 'codex', accountId: null })).toMatchObject({ code: 'invalid-params' });
    });
});

describe('B-850a account checks', () => {
    it('HTTP: 2xx ok, 401/403 definite, everything else unverified with a reason', () => {
        expect(classifyHttpCheck('claude-api', 200, '', 1)).toEqual({ status: 'ok', at: 1 });
        expect(classifyHttpCheck('claude-api', 401, '', 1).status).toBe('invalid');
        expect(classifyHttpCheck('claude-subscription', 403, '', 1).status).toBe('expired');
        expect(classifyHttpCheck('claude-api', 404, '{"error":"model not found"}', 1)).toEqual({ status: 'unverified', at: 1, detail: 'HTTP 404: {"error":"model not found"}' });
    });
    it('claude -p: exit 0 ok, 401 text expired, other failure unverified; details never echo a token', () => {
        expect(classifyClaudeCheck(0, 'pong', 1).status).toBe('ok');
        expect(classifyClaudeCheck(1, 'Failed to authenticate. API Error: 401 OAuth access token is invalid.', 1).status).toBe('expired');
        expect(classifyClaudeCheck(1, 'ENOTFOUND api.anthropic.com', 1)).toEqual({ status: 'unverified', at: 1, detail: 'ENOTFOUND api.anthropic.com' });
        expect(sanitizeDetail(`bad ${OAT}abcdef123 here`)).toBe('bad sk-ant-… here');
    });
});
