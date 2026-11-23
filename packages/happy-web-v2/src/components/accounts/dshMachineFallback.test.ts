// B-960: the machine login has no DeepSeek key — the Web says which account new sessions use.
import { describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import { dshHelpAccountLink, parseAgentProfilesState, resolveSpawnAccount, spawnAgentProfileParam } from '@/sync/agentProfiles';
import { zhHans } from '@/text/translations/zh-Hans';
import { en } from '@/text/_default';

installBrowserTestGlobals();
const { machineLoginSubtitleText } = await import('./MachineAccounts');
const { spawnDefaultOptionLabel } = await import('./SpawnAccountPicker');

const NOW = 1_000;
const dsh = (over: Record<string, unknown> = {}) => ({ id: 'dsh-coding', label: 'dsh_coding', agent: 'dsh', kind: 'dsh-api', status: 'ok', createdAt: 5, ...over });
const stateOf = (extra: Record<string, unknown>, accounts: unknown[] = [dsh()], defaults: Record<string, string> = {}) =>
    parseAgentProfilesState({ daemonPid: 1, updatedAt: 1, accounts, defaults, kinds: ['dsh-api'], features: ['launch-accounts', 'dsh-base-url'], ...extra })!;
// Echo translator: key + params, so the test pins which text is chosen.
const t = ((key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key) as never;

describe('B-960 new-session account (draft / dialog)', () => {
    it('machine login without a key + a usable account → that account, sent as nothing (the daemon applies the same rule)', () => {
        const state = stateOf({ machineLoginKey: { dsh: false } });
        const resolved = resolveSpawnAccount(state, 'dsh', undefined, NOW);
        expect(resolved).toMatchObject({ kind: 'account', account: { id: 'dsh-coding' }, fromDefault: true, fromFallback: true });
        expect(spawnAgentProfileParam(state, 'dsh', undefined)).toEqual({});
        expect(spawnDefaultOptionLabel(state, 'dsh', 'm1', null, t)).toBe('accounts.draftDefaultFallback:{"label":"dsh_coding"}');
    });

    it('explicit machine login, a key on the machine, an older daemon, or a set default → unchanged', () => {
        expect(resolveSpawnAccount(stateOf({ machineLoginKey: { dsh: false } }), 'dsh', null, NOW)).toEqual({ kind: 'machine', explicit: true });
        expect(resolveSpawnAccount(stateOf({ machineLoginKey: { dsh: true } }), 'dsh', undefined, NOW)).toEqual({ kind: 'machine', explicit: false });
        expect(resolveSpawnAccount(stateOf({}), 'dsh', undefined, NOW)).toEqual({ kind: 'machine', explicit: false });
        expect(spawnDefaultOptionLabel(stateOf({}), 'dsh', 'm1', null, t)).toBe('accounts.draftDefaultMachineLogin');
        const withDefault = stateOf({ machineLoginKey: { dsh: false } }, [dsh()], { dsh: 'dsh-coding' });
        expect(resolveSpawnAccount(withDefault, 'dsh', undefined, NOW)).toMatchObject({ kind: 'account', fromDefault: true });
        expect(resolveSpawnAccount(withDefault, 'dsh', undefined, NOW)).not.toHaveProperty('fromFallback');
    });

    it('a rejected key is no fallback', () => {
        const state = stateOf({ machineLoginKey: { dsh: false } }, [dsh({ status: 'invalid' })]);
        expect(resolveSpawnAccount(state, 'dsh', undefined, NOW)).toEqual({ kind: 'machine', explicit: false });
    });

    it('a non-boolean report is ignored', () => {
        expect(stateOf({ machineLoginKey: { dsh: 'no' } }).machineLoginKey).toEqual({});
    });
});

describe('B-960 accounts page: 本机登录 row', () => {
    it('says which account new sessions use, or that one is needed; else as before', () => {
        const noKey = stateOf({ machineLoginKey: { dsh: false } });
        expect(machineLoginSubtitleText(noKey, 'dsh', noKey.accounts[0], t)).toBe('accounts.machineLoginNoKeyFallback:{"label":"dsh_coding"}');
        expect(machineLoginSubtitleText(stateOf({ machineLoginKey: { dsh: false } }, []), 'dsh', null, t)).toBe('accounts.machineLoginNoKeyAdd');
        expect(machineLoginSubtitleText(stateOf({ machineLoginKey: { dsh: true } }), 'dsh', null, t)).toBe('accounts.machineLoginSubtitleDsh');
        expect(machineLoginSubtitleText(stateOf({}), 'dsh', null, t)).toBe('accounts.machineLoginSubtitleDsh');
    });

    it('has Chinese and English text', () => {
        expect(zhHans.accounts.machineLoginNoKeyFallback({ label: 'dsh_coding' })).toBe('这台机器没有 DeepSeek key，新会话会改用 dsh_coding');
        expect(en.accounts.machineLoginNoKeyFallback({ label: 'dsh_coding' })).toContain('dsh_coding');
        expect(zhHans.accounts.draftDefaultFallback({ label: 'dsh_coding' })).toBe('机器默认 · dsh_coding（本机没有 key）');
    });
});

describe('B-960b copy follows the actual state', () => {
    it('new-session dsh help: 「管理账号」 once an account exists, 「添加为账号」 only with none', () => {
        expect(dshHelpAccountLink(stateOf({ machineLoginKey: { dsh: false } }))).toBe('manage');
        expect(dshHelpAccountLink(stateOf({ machineLoginKey: { dsh: false } }, [dsh({ status: 'unverified' })], { dsh: 'dsh-coding' }))).toBe('manage');
        expect(dshHelpAccountLink(stateOf({}, []))).toBe('add');
        expect(dshHelpAccountLink(null)).toBe('add');
        expect(dshHelpAccountLink(stateOf({}, [{ ...dsh(), id: 'c1', agent: 'claude', kind: 'anthropic-api' }]))).toBe('add');
    });

    it('本机登录 row: an account set as default is named, never 「需要在下面添加账号」', () => {
        // QA R75 P3-2: default set to an unverified account, machine without a key.
        const withDefault = stateOf({ machineLoginKey: { dsh: false } }, [dsh({ status: 'unverified' })], { dsh: 'dsh-coding' });
        expect(machineLoginSubtitleText(withDefault, 'dsh', null, t)).toBe('accounts.machineLoginNoKeyDefault:{"label":"dsh_coding"}');
        // Accounts exist but none usable, no default: fix one below, not add one.
        const unusable = stateOf({ machineLoginKey: { dsh: false } }, [dsh({ status: 'invalid' })]);
        expect(machineLoginSubtitleText(unusable, 'dsh', null, t)).toBe('accounts.machineLoginNoKeyPick');
        // A default pointing at a removed account falls through to the remaining state.
        expect(machineLoginSubtitleText(stateOf({ machineLoginKey: { dsh: false } }, [], { dsh: 'gone' }), 'dsh', null, t)).toBe('accounts.machineLoginNoKeyAdd');
    });

    it('has Chinese and English text', () => {
        expect(zhHans.newSessionModal.dshManageLink).toBe('管理账号');
        expect(en.newSessionModal.dshManageLink).toBe('Manage accounts');
        expect(zhHans.newSessionModal.dshHelp).not.toContain('API key');
        expect(en.newSessionModal.dshHelp).not.toContain('API key');
        expect(zhHans.accounts.machineLoginNoKeyDefault({ label: 'dsh_coding' })).toBe('这台机器没有 DeepSeek key，新会话用默认账号 dsh_coding');
        expect(en.accounts.machineLoginNoKeyDefault({ label: 'dsh_coding' })).toContain('dsh_coding');
        expect(zhHans.accounts.machineLoginNoKeyPick).not.toContain('添加');
        expect(en.accounts.machineLoginNoKeyPick).not.toMatch(/add an account/i);
    });
});
