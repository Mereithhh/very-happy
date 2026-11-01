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
        expect(mod.sessionAccountFacts(session({ flavor: 'codex' }), machine())).toBeNull();
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
        const lines = mod.switchConfirmLines({ accountId: 'a2', label: 'Org B', cacheMiss: true }, 'dev-sg', false, t);
        expect(lines).toEqual(['accounts.switchRestart{"machine":"dev-sg"}', '✓ accounts.switchHistory', '⚠ accounts.switchCache']);
        const working = mod.switchConfirmLines({ accountId: 'h1', label: 'llm-hub', cacheMiss: false, model: 'kimi-k3' }, 'dev-sg', true, t);
        expect(working).toEqual(['accounts.switchRestart{"machine":"dev-sg"}', '✓ accounts.switchHistory', '⚠ accounts.switchInterrupt', 'accounts.switchModel{"model":"kimi-k3"}']);
    });

    it('settings deep link keeps the machine (and the account to re-login)', () => {
        expect(mod.accountSettingsHref('m 1')).toBe('/settings/models-accounts?machine=m+1');
        expect(mod.accountSettingsHref('m1', 'a2')).toBe('/settings/models-accounts?machine=m1&relogin=a2');
    });
});
