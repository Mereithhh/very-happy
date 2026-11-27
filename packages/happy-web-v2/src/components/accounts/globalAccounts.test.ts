import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import { accountEditable, isGlobalAccount, parseAgentProfilesState } from '@/sync/agentProfiles';
import { accountTagText } from './accountText';

installBrowserTestGlobals();
const { withLegacyTest } = await import('./MachineAccounts');

/** B-981 global model channels in the account lists (pure parts). */
const t = ((key: string) => ({ 'accounts.globalBadge': '全局', 'accounts.kindApi': 'API', 'accounts.kindLocalProvider': '本机供应商', 'accounts.kindSubscription': '订阅' } as Record<string, string>)[key] ?? key) as any;

describe('B-981 global channel accounts', () => {
    const global = { id: 'global-team-gw', label: 'Team gateway', agent: 'claude', kind: 'claude-api', status: 'unverified', scope: 'global', keySource: 'stored', models: ['model-a'] };
    const local = { id: 'hub', label: 'Hub', agent: 'claude', kind: 'claude-api', status: 'ok' };

    it('the daemon summary keeps `scope` through the Web parse', () => {
        const state = parseAgentProfilesState({ daemonPid: 1, updatedAt: 1, accounts: [global, local], defaults: {} });
        expect(state?.accounts.map((a) => [a.id, isGlobalAccount(a)])).toEqual([['global-team-gw', true], ['hub', false]]);
    });

    it('global and legacy accounts cannot be renamed or removed; local ones can; an unknown scope is local', () => {
        expect(accountEditable(global)).toBe(false);
        expect(accountEditable({ legacy: true })).toBe(false);
        expect(accountEditable({ ...local, legacy: false })).toBe(true);
        expect(accountEditable({ scope: 'something-newer' })).toBe(true);
    });

    it('one-line lists say 「全局 · API」 for a global channel', () => {
        expect(accountTagText(global, t)).toBe('全局 · API');
        expect(accountTagText(local, t)).toBe('API');
        expect(accountTagText({ ...global, kind: 'codex-provider' }, t)).toBe('全局 · 本机供应商');
    });

    it('a global channel shows its last test result (the daemon does not persist it)', () => {
        expect(withLegacyTest(global, { ...global, status: 'ok', checkedAt: 5 })).toMatchObject({ status: 'ok', checkedAt: 5 });
        expect(withLegacyTest(local, { ...local, status: 'invalid' }).status).toBe('ok');
    });
});

describe('B-981 wiring (source assertions, verified with scripts/dev/mutation-check.mjs)', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    it('settings rows show the chip and offer no rename / delete for a global channel; pickers use the global tag', () => {
        const rows = read('./MachineAccounts.tsx');
        expect(rows).toContain("{global && <span data-testid=\"account-global-chip\"><Chip>{t('accounts.globalBadge')}</Chip></span>}");
        expect(rows).toContain('...(global ? [] : [');
        expect(rows).toContain('const editable = online && accountEditable(account);');
        expect(read('./SpawnAccountPicker.tsx')).toContain("meta: status === 'ok' ? accountTagText(account, t)");
        expect(read('../../screens/session/sessionAccount.ts')).toContain('tag: accountTagText(account, t),');
    });
});
