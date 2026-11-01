/**
 * B-850c: the run-setup 账号 block, the API account model list and the switch
 * confirm — pure parts of sessionAccount.ts (gate: old CLI / old wrapper /
 * capability + online).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

let mod: typeof import('./sessionAccount');
beforeAll(async () => {
    installBrowserTestGlobals();
    mod = await import('./sessionAccount');
});

const t = ((key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key)) as never;
const NOW = 1_800_000_000_000;
const accounts = [
    { id: 'a1', label: 'Org A', agent: 'claude', kind: 'claude-subscription', status: 'ok' },
    { id: 'a2', label: 'Org B', agent: 'claude', kind: 'claude-subscription', status: 'expired' },
    { id: 'h1', label: 'llm-hub', agent: 'claude', kind: 'claude-api', status: 'ok', models: ['kimi-k3', 'glm-5.3'] },
];
const machine = (withAccounts = true) => ({ id: 'm1', active: true, metadata: { displayName: 'dev-sg', host: 'h' }, daemonState: { pid: 7, ...(withAccounts ? { agentProfiles: { daemonPid: 7, updatedAt: 1, accounts, defaults: {} } } : {}) } });
const session = (metadata: Record<string, unknown>) => ({ presence: 'online', metadata: { path: '/r', host: 'h', machineId: 'm1', flavor: 'claude', capabilities: ['agent-profile-v1'], ...metadata } });
const actions = { openSettings: vi.fn(), openMachine: vi.fn() };

describe('sessionAccountFacts', () => {
    it('no section for agents without accounts', () => {
        expect(mod.sessionAccountFacts(session({ flavor: 'gemini' }), machine())).toBeNull();
        expect(mod.sessionAccountFacts(null, machine())).toBeNull();
    });
    it('reads the bound account and the machine list', () => {
        const facts = mod.sessionAccountFacts(session({ agentProfile: { id: 'a1', label: 'Org A', kind: 'claude-subscription', status: 'active' } }), machine())!;
        expect(facts).toMatchObject({ machineId: 'm1', machineName: 'dev-sg', capable: true, online: true, profile: { id: 'a1' } });
        expect(facts.state?.accounts).toHaveLength(3);
    });
});

describe('buildAccountSection', () => {
    it('old CLI: only 本机登录 + 升级 CLI, nothing switchable', () => {
        const section = mod.buildAccountSection(mod.sessionAccountFacts(session({}), machine(false))!, t, actions, NOW);
        expect(section.rows.map((r) => r.key)).toEqual([mod.MACHINE_LOGIN_KEY]);
        expect(section.switchable).toBe(false);
        expect(section.note?.text).toBe('accounts.upgradeCli');
        section.note?.action?.onSelect();
        expect(actions.openMachine).toHaveBeenCalled();
    });

    it('new CLI, old wrapper (no capability): 本机登录 + why', () => {
        const section = mod.buildAccountSection(mod.sessionAccountFacts(session({ capabilities: [] }), machine())!, t, actions, NOW);
        expect(section.rows.map((r) => r.key)).toEqual([mod.MACHINE_LOGIN_KEY]);
        expect(section.note?.text).toBe('accounts.oldWrapper');
        expect(section.switchable).toBe(false);
    });

    it('lists the machine accounts; an expired one is disabled with 重新登录', () => {
        const section = mod.buildAccountSection(mod.sessionAccountFacts(session({ agentProfile: null }), machine())!, t, actions, NOW);
        expect(section.value).toBe(mod.MACHINE_LOGIN_KEY);
        expect(section.rows.map((r) => [r.key, !!r.disabled])).toEqual([[mod.MACHINE_LOGIN_KEY, false], ['a1', false], ['a2', true], ['h1', false]]);
        const expired = section.rows.find((r) => r.key === 'a2')!;
        expect(expired.status).toEqual({ text: 'accounts.statusExpired', tone: 'err' });
        expired.action!.onSelect();
        expect(actions.openSettings).toHaveBeenCalledWith('a2');
        expect(section.switchable).toBe(true);
    });

    it('offline session: rows shown, not switchable; a deleted bound account stays visible', () => {
        const offline = { ...session({ agentProfile: { id: 'gone', label: 'Old', kind: 'claude-api', status: 'unavailable', reason: 'missing' } }), presence: 1 };
        const section = mod.buildAccountSection(mod.sessionAccountFacts(offline, machine())!, t, actions, NOW);
        expect(section.switchable).toBe(false);
        expect(section.value).toBe('gone');
        expect(section.rows.at(-1)).toMatchObject({ key: 'gone', name: 'Old', disabled: true });
    });
});

describe('sessionApiModels', () => {
    it('API account: its models, pinned first-selected; subscription / unavailable: none', () => {
        const onHub = mod.sessionAccountFacts(session({ agentProfile: { id: 'h1', label: 'llm-hub', kind: 'claude-api', status: 'active', model: 'glm-5.3' } }), machine());
        expect(mod.sessionApiModels(onHub)).toMatchObject({ models: ['kimi-k3', 'glm-5.3'], pinned: 'glm-5.3', account: { id: 'h1' } });
        const onSub = mod.sessionAccountFacts(session({ agentProfile: { id: 'a1', label: 'Org A', kind: 'claude-subscription', status: 'active' } }), machine());
        expect(mod.sessionApiModels(onSub)).toBeNull();
        const down = mod.sessionAccountFacts(session({ agentProfile: { id: 'h1', label: 'llm-hub', kind: 'claude-api', status: 'unavailable' } }), machine());
        expect(mod.sessionApiModels(down)).toBeNull();
    });
});

describe('switch confirm', () => {
    it('says restart in place, history kept, cache miss across organizations, interrupt only when working', () => {
        const lines = mod.switchConfirmLines({ accountId: 'a2', label: 'Org B', cacheMiss: true, crossType: false }, 'dev-sg', false, t);
        expect(lines).toEqual(['accounts.switchRestart{"machine":"dev-sg"}', '✓ accounts.switchHistory', '⚠ accounts.switchHistorySent', '⚠ accounts.switchCache']);
        const working = mod.switchConfirmLines({ accountId: 'h1', label: 'llm-hub', cacheMiss: false, crossType: false, model: 'kimi-k3' }, 'dev-sg', true, t);
        expect(working).toEqual(['accounts.switchRestart{"machine":"dev-sg"}', '✓ accounts.switchHistory', '⚠ accounts.switchInterrupt', 'accounts.switchModel{"model":"kimi-k3"}']);
    });

    it('settings deep link keeps the machine (and the account to re-login)', () => {
        expect(mod.accountSettingsHref('m 1')).toBe('/settings/models-accounts?machine=m+1');
        expect(mod.accountSettingsHref('m1', 'a2')).toBe('/settings/models-accounts?machine=m1&relogin=a2');
    });
});

describe('wire v2', () => {
    it('account events map by kind; anything else is not an account event', () => {
        expect(mod.accountEventKind('agent-profile-unavailable')).toBe('unavailable');
        expect(mod.accountEventKind('agent-profile-auth-failed')).toBe('auth-failed');
        expect(mod.accountEventKind('agent-profile-warning')).toBe('warning');
        expect(mod.accountEventKind('claude-auth-failed')).toBeNull();
        expect(mod.accountEventKind(undefined)).toBeNull();
    });

    it('the machine-login card only applies without a bound account', () => {
        expect(mod.machineLoginCardApplies({})).toBe(true); // old wrapper
        expect(mod.machineLoginCardApplies({ agentProfile: null })).toBe(true); // machine login
        expect(mod.machineLoginCardApplies({ agentProfile: { id: 'a1', label: 'Org A', kind: 'claude-subscription', status: 'active' } })).toBe(false);
    });

    it('auth-failed: an active binding whose account the daemon now reports expired', () => {
        const facts = mod.sessionAccountFacts(session({ agentProfile: { id: 'a2', label: 'Org B', kind: 'claude-subscription', status: 'active' } }), machine())!;
        expect(mod.boundAccountRejected(facts, NOW)).toMatchObject({ status: 'expired', account: { id: 'a2' } });
        const ok = mod.sessionAccountFacts(session({ agentProfile: { id: 'a1', label: 'Org A', kind: 'claude-subscription', status: 'active' } }), machine())!;
        expect(mod.boundAccountRejected(ok, NOW)).toBeNull();
    });

    it("bind 'pending' shows 重启中 until metadata.agentProfile is the target", () => {
        mod.notePendingSwitch('s1', { targetId: 'h1', label: 'llm-hub', at: NOW });
        const onA1 = { id: 'a1', label: 'Org A', kind: 'claude-subscription', status: 'active' as const };
        expect(mod.pendingSwitchFor('s1', onA1, NOW + 1000)).toMatchObject({ label: 'llm-hub' });
        expect(mod.pendingSwitchFor('s1', { ...onA1, id: 'h1' }, NOW + 1000)).toBeNull();
        expect(mod.pendingSwitchFor('s1', onA1, NOW + 6 * 60_000)).toBeNull();
        mod.notePendingSwitch('s2', { targetId: null, label: null, at: NOW });
        expect(mod.pendingSwitchFor('s2', null, NOW)).toBeNull(); // machine login reached
        expect(mod.pendingSwitchFor('s2', undefined, NOW)).not.toBeNull(); // old/unknown: keep waiting
    });
});

// ---- B-850c2: Codex (wire v3) ----

const codexAccounts = [
    { id: 'gpt-a', label: 'me@x.com', agent: 'codex', kind: 'codex-chatgpt', status: 'ok', email: 'me@x.com', planType: 'plus' },
    { id: 'hub', label: 'LLM Hub', agent: 'codex', kind: 'codex-provider', status: 'ok', provider: 'llmhub', models: ['gpt-5.6-sol'] },
];
const codexMachine = (codex = true) => ({ id: 'm1', active: true, metadata: { displayName: 'dev-sg', host: 'h' }, daemonState: { pid: 7, agentProfiles: {
    daemonPid: 7, updatedAt: 1, accounts: codex ? [...accounts, ...codexAccounts] : accounts, defaults: {},
    ...(codex ? { kinds: ['claude-subscription', 'claude-api', 'codex-chatgpt', 'codex-provider'], codexProviders: [{ id: 'llmhub', baseUrl: 'https://llm-hub.apodex.app/v1', envKey: 'LLMHUB_API_KEY' }] } : {}),
} } });
const codexSession = (metadata: Record<string, unknown>) => session({ flavor: 'codex', ...metadata });

describe('Codex sessions', () => {
    it('list only Codex accounts — the account agent must match the session flavor', () => {
        const facts = mod.sessionAccountFacts(codexSession({ agentProfile: null }), codexMachine())!;
        expect(facts.agent).toBe('codex');
        const section = mod.buildAccountSection(facts, t, actions, NOW);
        expect(section.rows.map((r) => r.key)).toEqual([mod.MACHINE_LOGIN_KEY, 'gpt-a', 'hub']);
        expect(section.rows.find((r) => r.key === 'hub')?.tag).toBe('accounts.kindLocalProvider');
        expect(section.rows.find((r) => r.key === 'gpt-a')?.tag).toBe('accounts.kindSubscription');
        // A Claude session on the same machine never sees them.
        const claude = mod.buildAccountSection(mod.sessionAccountFacts(session({ agentProfile: null }), codexMachine())!, t, actions, NOW);
        expect(claude.rows.map((r) => r.key)).toEqual([mod.MACHINE_LOGIN_KEY, 'a1', 'a2', 'h1']);
    });

    it('a CLI with Claude accounts only (B-850a): Codex gets 本机登录 · 升级 CLI', () => {
        const section = mod.buildAccountSection(mod.sessionAccountFacts(codexSession({}), codexMachine(false))!, t, actions, NOW);
        expect(section.rows.map((r) => r.key)).toEqual([mod.MACHINE_LOGIN_KEY]);
        expect(section.switchable).toBe(false);
        expect(section.note?.text).toBe('accounts.upgradeCli');
    });

    it('a Codex provider account keeps the Codex model picker (no API model pin)', () => {
        const facts = mod.sessionAccountFacts(codexSession({ agentProfile: { id: 'hub', label: 'LLM Hub', kind: 'codex-provider', status: 'active', model: 'gpt-5.6-sol' } }), codexMachine());
        expect(mod.sessionApiModels(facts)).toBeNull();
    });

    it('cross-type switch (ChatGPT ↔ API ↔ machine) warns the new account may refuse the history', () => {
        const lines = mod.switchConfirmLines({ accountId: 'hub', label: 'LLM Hub', cacheMiss: true, crossType: true }, 'dev-sg', false, t);
        expect(lines).toEqual(['accounts.switchRestart{"machine":"dev-sg"}', '✓ accounts.switchHistory', '⚠ accounts.switchHistorySent', '⚠ accounts.switchCache', '⚠ accounts.switchCrossType']);
    });

    it('history-rejected is an account event', () => {
        expect(mod.accountEventKind('agent-profile-history-rejected')).toBe('history-rejected');
    });

    it('「换回原账号」 remembers what ran before the last switch, per session', () => {
        mod.notePreviousAccount('cs1', { id: 'gpt-a', label: 'me@x.com' });
        const onHub = { id: 'hub', label: 'LLM Hub', kind: 'codex-provider', status: 'active' as const };
        expect(mod.previousAccountFor('cs1', onHub)).toEqual({ id: 'gpt-a', label: 'me@x.com' });
        // already back on it → nothing to switch back to
        expect(mod.previousAccountFor('cs1', { ...onHub, id: 'gpt-a' })).toBeUndefined();
        mod.notePreviousAccount('cs2', null);
        expect(mod.previousAccountFor('cs2', onHub)).toBeNull(); // the machine login
        expect(mod.previousAccountFor('cs2', null)).toBeUndefined();
        expect(mod.previousAccountFor('unknown', onHub)).toBeUndefined();
        mod.notePreviousAccount('cs3', undefined); // old wrapper: unknown, not written
        expect(mod.previousAccountFor('cs3', onHub)).toBeUndefined();
    });
});
