import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateHookSettingsFile } from '@/claude/utils/generateHookSettings';
import { writeSideQuestionSettingsFile } from '@/claude/registerSideQuestionHandler';
import { oneShotArgs } from '@/claude/utils/titleGenerator';
import { accountClaudeSettings, loadWrapperAccount, noteAccountAuthFailure, shouldRecordSpawnAccount, unavailableNotice } from './wrapperAccount';
import { readAccountsFileV2, readSessionBindings, writeAccountSecret, writeAccountsFile, parseAccountsFile } from './store';

// Fake credentials, assembled at runtime so secret scanners do not flag test literals.
const OAT = ['sk', 'ant', 'oat01', ''].join('-');

function home() {
    const dir = mkdtempSync(join(tmpdir(), 'vh-b850-wrap-'));
    writeFileSync(join(dir, 'hub.key'), 'hub-secret\n');
    writeAccountsFile(dir, parseAccountsFile({ accounts: {
        'org-a': { agent: 'claude', kind: 'claude-subscription', label: 'Org A', createdAt: 1 },
        hub: { agent: 'claude', kind: 'claude-api', label: 'Hub', baseUrl: 'https://hub', key: { source: 'file', path: join(dir, 'hub.key') }, models: ['kimi'] },
        envhub: { agent: 'claude', kind: 'claude-api', label: 'Env hub', baseUrl: 'https://hub', key: { source: 'env', name: 'HUB_KEY' } },
    } }));
    writeAccountSecret(dir, 'org-a', OAT + 'ORGA');
    return dir;
}

describe('B-850a wrapper account', () => {
    it('records the spawn account only for a session without a binding (reconnect keeps its own)', () => {
        expect(shouldRecordSpawnAccount('org-a', false)).toBe(true);
        expect(shouldRecordSpawnAccount('org-a', true)).toBe(false);
        expect(shouldRecordSpawnAccount(undefined, false)).toBe(false);
        const dir = home();
        const env: NodeJS.ProcessEnv = { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'daemon-wide' };
        const a = loadWrapperAccount(dir, 's1', 'org-a', env);
        expect(a.profile).toEqual({ id: 'org-a', label: 'Org A', kind: 'claude-subscription', status: 'active' });
        expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: OAT + 'ORGA' });
        expect(readSessionBindings(dir).s1).toEqual({ account: 'org-a' });
        // reconnect of s1 with a different machine default must not rebind it
        loadWrapperAccount(dir, 's1', 'hub', {});
        expect(readSessionBindings(dir).s1).toEqual({ account: 'org-a' });
    });

    it('two sessions on one machine each get only their own credential', () => {
        const dir = home();
        const envA: NodeJS.ProcessEnv = { PATH: '/bin' };
        const envB: NodeJS.ProcessEnv = { PATH: '/bin' };
        loadWrapperAccount(dir, 'sa', 'org-a', envA);
        const b = loadWrapperAccount(dir, 'sb', 'hub', envB);
        expect(envA.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAT + 'ORGA');
        expect(JSON.stringify(envB)).not.toContain(OAT + 'ORGA');
        expect(JSON.stringify(envB)).not.toContain('hub-secret');
        expect(envB.ANTHROPIC_BASE_URL).toBe('https://hub');
        expect(String(b.settings.apiKeyHelper)).toContain('hub.key');
        expect(envB.CLAUDE_CODE_OAUTH_TOKEN).toBe('vh-account-unavailable');
        // one-shots (title generator, board analyzer) carry the same helper
        expect(accountClaudeSettings()).toEqual(b.settings);
        const args = oneShotArgs(accountClaudeSettings());
        expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ apiKeyHelper: b.settings.apiKeyHelper, disableAllHooks: true });
        loadWrapperAccount(dir, 'free', undefined, {});
        expect(accountClaudeSettings()).toEqual({});
    });

    it('env-sourced key: copied 0600 for the helper, removed from the session env, cleaned up', () => {
        const dir = home();
        const env: NodeJS.ProcessEnv = { HUB_KEY: 'from-daemon-env' };
        const a = loadWrapperAccount(dir, 's1', 'envhub', env);
        expect(env.HUB_KEY).toBeUndefined();
        const copy = String(a.settings.apiKeyHelper).match(/"([^"]*key-[^"]*)"$/)![1];
        expect(readFileSync(copy, 'utf8').trim()).toBe('from-daemon-env');
        expect(statSync(copy).mode & 0o777).toBe(0o600);
        a.cleanup();
        expect(() => statSync(copy)).toThrow();
    });

    it('unbound session: machine login, env untouched; missing account: unavailable notice, placeholder token', () => {
        const dir = home();
        const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'machine' };
        expect(loadWrapperAccount(dir, 'free', undefined, env).profile).toBeNull();
        expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'machine' });
        const gone = loadWrapperAccount(dir, 's9', 'deleted', env);
        expect(gone.unavailable).toBe(true);
        expect(gone.notices[0]).toBe(unavailableNotice(gone.profile!));
        expect(gone.notices[0]).toContain('will not fall back to the machine login');
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('vh-account-unavailable');
    });

    it('a mid-run rejection marks the bound account (subscription → expired)', () => {
        const dir = home();
        loadWrapperAccount(dir, 's1', 'org-a', {});
        expect(noteAccountAuthFailure(77)).toEqual({ label: 'Org A', status: 'expired' });
        expect(readAccountsFileV2(dir).accounts['org-a'].check).toEqual({ status: 'expired', at: 77, detail: 'rejected during a session' });
        loadWrapperAccount(dir, 's2', undefined, {});
        expect(noteAccountAuthFailure()).toBe(false);
    });

    it('settings files: account settings merged, hooks / disableAllHooks kept', () => {
        const extra = { apiKeyHelper: '"/n" -e "x" "/k"' };
        const hook = JSON.parse(readFileSync(generateHookSettingsFile(1234, undefined, extra), 'utf8'));
        expect(hook.apiKeyHelper).toBe(extra.apiKeyHelper);
        expect(hook.hooks.SessionStart).toHaveLength(1);
        const dir = mkdtempSync(join(tmpdir(), 'vh-b850-sq-'));
        const sq = JSON.parse(readFileSync(writeSideQuestionSettingsFile(dir, extra), 'utf8'));
        expect(sq).toEqual({ apiKeyHelper: extra.apiKeyHelper, disableAllHooks: true });
    });
});
