import { describe, expect, it } from 'vitest';
import {
    ACCOUNT_EXPIRING_MS,
    accountDisplayStatus,
    accountKindTag,
    accountNeedsRelogin,
    accountUsable,
    apiAccountModels,
    codexAccountFacts,
    codexProviderAddFields,
    isLoginTerminal,
    machineHasAgentAccounts,
    parseAgentProfilesState,
    parseLoginStatus,
    parseModelList,
    parseSpawnAccountError,
    planAccountSwitch,
    readMachineAgentProfiles,
    readSessionAgentProfile,
    resolveSpawnAccount,
    sessionSupportsAgentProfiles,
    spawnAgentProfileParam,
    type AgentProfileSummary,
} from './agentProfiles';

const NOW = 1_800_000_000_000;
const sub = (over: Partial<AgentProfileSummary> = {}): AgentProfileSummary => ({ id: 'a1', label: 'Org A', agent: 'claude', kind: 'claude-subscription', status: 'ok', ...over });
const api = (over: Partial<AgentProfileSummary> = {}): AgentProfileSummary => ({ id: 'h1', label: 'llm-hub', agent: 'claude', kind: 'claude-api', status: 'ok', baseUrl: 'https://llm-hub.example', models: ['kimi-k3', 'glm-5.3'], keySource: 'file', keyRef: '~/.k', ...over });
const daemon = (agentProfiles: unknown, pid = 42) => ({ daemonState: { pid, agentProfiles } });
const stateOf = (accounts: unknown[], defaults: Record<string, unknown> = {}) => ({ daemonPid: 42, updatedAt: 1, accounts, defaults });

describe('B-850c machine capability (daemonState.agentProfiles)', () => {
    it('trusts only the current daemon run', () => {
        expect(readMachineAgentProfiles(daemon(stateOf([sub()])))?.accounts).toHaveLength(1);
        // a stale copy from an earlier daemon (pid changed) is an old CLI
        expect(readMachineAgentProfiles(daemon(stateOf([sub()]), 43))).toBeNull();
        expect(readMachineAgentProfiles({ daemonState: { pid: 42 } })).toBeNull();
        expect(readMachineAgentProfiles(null)).toBeNull();
    });

    it('drops a malformed account, not the list; keeps only string defaults; v1 kinds when absent', () => {
        const state = parseAgentProfilesState(stateOf([sub(), { id: 3 }, api()], { claude: 'h1', codex: 7 }));
        expect(state?.accounts.map((a) => a.id)).toEqual(['a1', 'h1']);
        expect(state?.defaults).toEqual({ claude: 'h1' });
        expect(state?.kinds).toEqual(['claude-subscription', 'claude-api']);
        expect(parseAgentProfilesState({ ...stateOf([]), kinds: ['codex-chatgpt'] })?.kinds).toEqual(['codex-chatgpt']);
    });
});

describe('metadata.agentProfile whitelist', () => {
    it('absent = old wrapper, null = machine login, unknown status reads active', () => {
        expect(readSessionAgentProfile(undefined)).toBeUndefined();
        expect(readSessionAgentProfile(null)).toBeNull();
        expect(readSessionAgentProfile({ id: 'a1', label: 'Org A', kind: 'claude-subscription', status: 'unavailable', reason: 'expired' }))
            .toEqual({ id: 'a1', label: 'Org A', kind: 'claude-subscription', status: 'unavailable', reason: 'expired' });
        expect(readSessionAgentProfile({ id: 'a1', label: 'x', kind: 'k', status: 'paused-v2' })?.status).toBe('active');
        expect(readSessionAgentProfile({ label: 'no id' })).toBeUndefined();
    });

    it('capability gate', () => {
        expect(sessionSupportsAgentProfiles({ capabilities: ['agent-profile-v1'] })).toBe(true);
        expect(sessionSupportsAgentProfiles({ capabilities: [] })).toBe(false);
        expect(sessionSupportsAgentProfiles(null)).toBe(false);
    });
});

describe('status and type tags', () => {
    it('Q1 tags', () => {
        expect(accountKindTag('claude-subscription')).toBe('subscription');
        expect(accountKindTag('claude-api')).toBe('api');
        expect(accountKindTag('codex-provider')).toBe('local-provider');
        expect(accountKindTag('something-new')).toBe('api');
    });

    it('expiring within 30 days, expired at expiresAt; unknown status is unverified', () => {
        expect(accountDisplayStatus(sub({ expiresAt: NOW + ACCOUNT_EXPIRING_MS + 1 }), NOW)).toBe('ok');
        expect(accountDisplayStatus(sub({ expiresAt: NOW + ACCOUNT_EXPIRING_MS }), NOW)).toBe('expiring');
        expect(accountDisplayStatus(sub({ expiresAt: NOW }), NOW)).toBe('expired');
        expect(accountDisplayStatus(sub({ status: 'invalid', expiresAt: NOW + 5 }), NOW)).toBe('invalid');
        expect(accountDisplayStatus(sub({ status: 'brand-new' }), NOW)).toBe('unverified');
    });

    it('usable: ok / expiring / unverified; re-login only for subscriptions', () => {
        expect(['ok', 'expiring', 'unverified'].every((s) => accountUsable(s as never))).toBe(true);
        expect(['expired', 'invalid', 'missing-secret'].some((s) => accountUsable(s as never))).toBe(false);
        expect(accountNeedsRelogin('claude-subscription', 'expired')).toBe(true);
        expect(accountNeedsRelogin('claude-api', 'invalid')).toBe(false);
    });
});

describe('Q3: new session account', () => {
    const state = parseAgentProfilesState(stateOf([sub(), api({ status: 'invalid' }), sub({ id: 'old', label: 'Org B', expiresAt: NOW - 1 })], { claude: 'a1' }))!;

    it('old CLI / Codex on a B-850a daemon: unsupported, nothing is sent', () => {
        expect(resolveSpawnAccount(null, 'claude', 'a1', NOW)).toEqual({ kind: 'unsupported' });
        expect(resolveSpawnAccount(state, 'codex', undefined, NOW)).toEqual({ kind: 'unsupported' });
        expect(spawnAgentProfileParam(null, 'claude', 'a1')).toEqual({});
        expect(spawnAgentProfileParam(state, 'codex', 'a1')).toEqual({});
    });

    it('undefined = machine default (not sent), null = machine login (sent as null)', () => {
        expect(resolveSpawnAccount(state, 'claude', undefined, NOW)).toMatchObject({ kind: 'account', fromDefault: true, account: { id: 'a1' } });
        expect(spawnAgentProfileParam(state, 'claude', undefined)).toEqual({});
        expect(resolveSpawnAccount(state, 'claude', null, NOW)).toEqual({ kind: 'machine', explicit: true });
        expect(spawnAgentProfileParam(state, 'claude', null)).toEqual({ agentProfileId: null });
        const noDefault = { ...state, defaults: {} };
        expect(resolveSpawnAccount(noDefault, 'claude', undefined, NOW)).toEqual({ kind: 'machine', explicit: false });
    });

    it('blocks an expired, rejected or missing account — explicit or the default', () => {
        expect(resolveSpawnAccount(state, 'claude', 'old', NOW)).toEqual({ kind: 'blocked', reason: 'expired', label: 'Org B', fromDefault: false });
        expect(resolveSpawnAccount(state, 'claude', 'h1', NOW)).toMatchObject({ kind: 'blocked', reason: 'invalid' });
        expect(resolveSpawnAccount(state, 'claude', 'gone', NOW)).toEqual({ kind: 'blocked', reason: 'missing', label: null, fromDefault: false });
        expect(resolveSpawnAccount({ ...state, defaults: { claude: 'old' } }, 'claude', undefined, NOW)).toMatchObject({ kind: 'blocked', fromDefault: true });
    });

    it('reads the daemon refusal', () => {
        expect(parseSpawnAccountError('agent-profile-unavailable:expired')).toBe('expired');
        expect(parseSpawnAccountError('Error: agent-profile-unavailable:missing-secret (x)')).toBe('missing-secret');
        expect(parseSpawnAccountError('spawn failed')).toBeNull();
    });
});

describe('switch plan and API models', () => {
    it('cache-miss whenever the account changes; API pins the first model unless one is picked', () => {
        const current = readSessionAgentProfile({ id: 'a1', label: 'Org A', kind: 'claude-subscription', status: 'active' });
        expect(planAccountSwitch(current, sub({ id: 'a2', label: 'Org B' }))).toEqual({ accountId: 'a2', label: 'Org B', cacheMiss: true, crossType: false });
        expect(planAccountSwitch(current, null)).toEqual({ accountId: null, label: null, cacheMiss: true, crossType: false });
        expect(planAccountSwitch(null, api())).toEqual({ accountId: 'h1', label: 'llm-hub', cacheMiss: true, crossType: false, model: 'kimi-k3' });
        const onHub = readSessionAgentProfile({ id: 'h1', label: 'llm-hub', kind: 'claude-api', status: 'active', model: 'kimi-k3' });
        expect(planAccountSwitch(onHub, api(), 'glm-5.3')).toEqual({ accountId: 'h1', label: 'llm-hub', cacheMiss: false, crossType: false, model: 'glm-5.3' });
    });

    it('API model list keeps the pinned model even when the account no longer lists it', () => {
        expect(apiAccountModels(api(), 'kimi-k3')).toEqual(['kimi-k3', 'glm-5.3']);
        expect(apiAccountModels(api(), 'old-model')).toEqual(['old-model', 'kimi-k3', 'glm-5.3']);
        expect(apiAccountModels(null, undefined)).toEqual([]);
    });

    it('model field parsing', () => {
        expect(parseModelList('kimi-k3, glm-5.3\nkimi-k3\n\n  x ')).toEqual(['kimi-k3', 'glm-5.3', 'x']);
    });
});

describe('login status', () => {
    it('unknown state keeps polling; only https urls are opened', () => {
        expect(parseLoginStatus({ loginId: 'l', state: 'waiting-code', url: 'https://claude.ai/oauth?x', expiresAt: 5 }))
            .toEqual({ loginId: 'l', state: 'waiting-code', flow: 'paste-code', url: 'https://claude.ai/oauth?x', expiresAt: 5 });
        expect(parseLoginStatus({ loginId: 'l', state: 'new-state' })?.state).toBe('exchanging');
        expect(parseLoginStatus({ loginId: 'l', state: 'waiting-code', url: 'javascript:alert(1)' })?.url).toBeUndefined();
        expect(parseLoginStatus({ state: 'x' })).toBeNull();
        expect(isLoginTerminal('exchanging')).toBe(false);
        expect(['succeeded', 'failed', 'canceled', 'expired'].every((s) => isLoginTerminal(s as never))).toBe(true);
    });
});

describe('wire v2 additions', () => {
    it("login 'starting' is a waiting state", () => {
        expect(parseLoginStatus({ loginId: 'l', state: 'starting' })?.state).toBe('starting');
        expect(isLoginTerminal('starting')).toBe(false);
    });
});

describe('B-850c2 Codex (wire v3)', () => {
    const gpt = sub({ id: 'gpt-a', label: 'me@x.com', agent: 'codex', kind: 'codex-chatgpt', email: 'me@x.com', planType: 'plus', keySource: 'stored' });
    const hub = api({ id: 'hub', label: 'LLM Hub', agent: 'codex', kind: 'codex-provider', provider: 'llmhub', models: ['gpt-5.6-sol'] });

    const ALL = ['claude-subscription', 'claude-api', 'codex-chatgpt', 'codex-provider'];
    it('`kinds` decides Codex support; absent = a B-850a daemon (Claude only)', () => {
        const b = parseAgentProfilesState({ ...stateOf([sub()]), kinds: ALL, codexProviders: [{ id: 'llmhub', baseUrl: 'https://h/v1', envKey: 'K' }, { id: 7 }, { id: 'bare' }] })!;
        expect(b.codexProviders).toEqual([{ id: 'llmhub', baseUrl: 'https://h/v1', envKey: 'K' }, { id: 'bare' }]);
        expect(machineHasAgentAccounts(b, 'codex')).toBe(true);
        expect(machineHasAgentAccounts(parseAgentProfilesState({ ...stateOf([]), kinds: ALL }), 'codex')).toBe(true); // no providers, still B-850b
        // no kinds: Codex parts do not count (B-850b always sends kinds)
        const a = parseAgentProfilesState({ ...stateOf([gpt], { codex: 'gpt-a' }), codexProviders: [] });
        expect(a?.kinds).toEqual(['claude-subscription', 'claude-api']);
        expect(machineHasAgentAccounts(a, 'codex')).toBe(false);
        expect(machineHasAgentAccounts(a, 'claude')).toBe(true);
        expect(machineHasAgentAccounts(parseAgentProfilesState({ ...stateOf([gpt]), kinds: ['claude-api'] }), 'codex')).toBe(false);
        expect(machineHasAgentAccounts(null, 'claude')).toBe(false);
    });

    it('tags: ChatGPT = 订阅, provider = 本机供应商 / API; re-login only for ChatGPT', () => {
        expect(accountKindTag('codex-chatgpt')).toBe('subscription');
        expect(accountKindTag('codex-provider')).toBe('local-provider');
        expect(accountNeedsRelogin('codex-chatgpt', 'expired')).toBe(true);
        expect(accountNeedsRelogin('codex-provider', 'invalid')).toBe(false);
        expect(codexAccountFacts(gpt)).toEqual({ email: 'me@x.com', plan: 'plus' });
        expect(codexAccountFacts(hub)).toEqual({ provider: 'llmhub' });
        expect(codexAccountFacts(sub())).toEqual({});
    });

    it('new Codex session: picks and blocks like Claude once the daemon serves Codex accounts', () => {
        const state = parseAgentProfilesState({ ...stateOf([sub(), gpt, { ...hub, status: 'invalid' }], { codex: 'gpt-a' }), kinds: ALL })!;
        expect(resolveSpawnAccount(state, 'codex', undefined, NOW)).toMatchObject({ kind: 'account', fromDefault: true, account: { id: 'gpt-a' } });
        expect(resolveSpawnAccount(state, 'codex', 'hub', NOW)).toMatchObject({ kind: 'blocked', reason: 'invalid', label: 'LLM Hub' });
        // a Claude account id is not a Codex account
        expect(resolveSpawnAccount(state, 'codex', 'a1', NOW)).toMatchObject({ kind: 'blocked', reason: 'missing' });
        expect(spawnAgentProfileParam(state, 'codex', 'gpt-a')).toEqual({ agentProfileId: 'gpt-a' });
        expect(spawnAgentProfileParam(state, 'codex', null)).toEqual({ agentProfileId: null });
        expect(spawnAgentProfileParam(state, 'codex', undefined)).toEqual({});
    });

    it('cross-type only for Codex across ChatGPT / provider / machine login', () => {
        const onGpt = readSessionAgentProfile({ id: 'gpt-a', label: 'me@x.com', kind: 'codex-chatgpt', status: 'active' });
        expect(planAccountSwitch(onGpt, hub, undefined, 'codex')).toMatchObject({ crossType: true, cacheMiss: true });
        expect(planAccountSwitch(onGpt, null, undefined, 'codex').crossType).toBe(true);
        expect(planAccountSwitch(null, gpt, undefined, 'codex').crossType).toBe(true);
        expect(planAccountSwitch(onGpt, { ...gpt, id: 'gpt-b' }, undefined, 'codex').crossType).toBe(false);
        const onHub = readSessionAgentProfile({ id: 'hub', label: 'LLM Hub', kind: 'codex-provider', status: 'active' });
        expect(planAccountSwitch(onHub, { ...hub, id: 'hub2' }, undefined, 'codex').crossType).toBe(false);
        expect(planAccountSwitch(onHub, hub, undefined, 'codex').crossType).toBe(false); // same account
        // Claude never warns cross-type; a Codex provider pins no API model on bind
        expect(planAccountSwitch(null, sub(), undefined, 'claude').crossType).toBe(false);
        expect(planAccountSwitch(onGpt, hub, undefined, 'codex').model).toBeUndefined();
    });

    it('device-code login: flow + userCode, Claude stays paste-code', () => {
        expect(parseLoginStatus({ loginId: 'l', state: 'waiting-code', flow: 'device-code', url: 'https://auth.openai.com/codex/device', userCode: ' ABCD-1234 ', expiresAt: 9 }))
            .toEqual({ loginId: 'l', state: 'waiting-code', flow: 'device-code', userCode: 'ABCD-1234', url: 'https://auth.openai.com/codex/device', expiresAt: 9 });
        expect(parseLoginStatus({ loginId: 'l', state: 'waiting-code', flow: 'something-new' })?.flow).toBe('paste-code');
        expect(parseLoginStatus({ loginId: 'l', state: 'waiting-code', userCode: '' })?.userCode).toBeUndefined();
    });

    it('provider add fields: config.toml provider (URL optional override) or own URL + wire API', () => {
        const base = { label: ' Hub ', provider: 'llmhub', baseUrl: '', wireApi: 'chat' as const, models: 'gpt-5.6-sol, gpt-5.4-mini' };
        expect(codexProviderAddFields(base)).toEqual({ label: 'Hub', provider: 'llmhub', models: ['gpt-5.6-sol', 'gpt-5.4-mini'] });
        expect(codexProviderAddFields({ ...base, baseUrl: 'https://x/v1' })).toEqual({ label: 'Hub', provider: 'llmhub', baseUrl: 'https://x/v1', models: ['gpt-5.6-sol', 'gpt-5.4-mini'] });
        expect(codexProviderAddFields({ ...base, provider: null, baseUrl: 'https://x/v1' })).toEqual({ label: 'Hub', wireApi: 'chat', baseUrl: 'https://x/v1', models: ['gpt-5.6-sol', 'gpt-5.4-mini'] });
        expect(codexProviderAddFields({ ...base, provider: null })).toBeNull(); // neither provider nor URL
        expect(codexProviderAddFields({ ...base, baseUrl: 'ftp://x' })).toBeNull();
        expect(codexProviderAddFields({ ...base, label: '  ' })).toBeNull();
    });
});
