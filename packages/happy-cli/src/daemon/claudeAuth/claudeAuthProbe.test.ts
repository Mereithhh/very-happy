import { describe, expect, it } from 'vitest';
import {
    buildClaudeAuthState, classifyAuthStatus, classifyLineage, claudeAuthStateChanged, diagnoseStores,
    interpretCredentialsFile, interpretSecurityRead, parseLaunchctlPid, resolveSdkClaudeBinary, withKeychainOffPath,
} from './claudeAuthProbe';

const LOGGED_IN = '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","analyticsDisabled":false,"projectsDirectory":"/Users/jojo/.claude/projects","email":"x@y","orgId":"o","orgName":"mereith","subscriptionType":"max"}';
const LOGGED_OUT = '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty","analyticsDisabled":false,"projectsDirectory":"/Users/jojo/.claude/projects"}';

describe('classifyAuthStatus', () => {
    it('ok for loggedIn:true', () => {
        expect(classifyAuthStatus({ stdout: LOGGED_IN, exitCode: 0, timedOut: false }, 'Claude local credentials'))
            .toEqual({ status: 'ok', authMethod: 'claude.ai', subscriptionType: 'max' });
    });
    it('not-logged-in for loggedIn:false regardless of exit code', () => {
        expect(classifyAuthStatus({ stdout: LOGGED_OUT, exitCode: 1, timedOut: false }, undefined).status).toBe('not-logged-in');
    });
    it('unknown (never not-logged-in) under non-local credential sources', () => {
        expect(classifyAuthStatus({ stdout: LOGGED_OUT, exitCode: 0, timedOut: false }, 'Amazon Bedrock'))
            .toMatchObject({ status: 'unknown', authMethod: 'Amazon Bedrock' });
        expect(classifyAuthStatus({ stdout: 'garbage', exitCode: 0, timedOut: false }, 'ANTHROPIC_API_KEY').status).toBe('unknown');
    });
    it('timeout / crash / spawn error', () => {
        expect(classifyAuthStatus({ stdout: '', exitCode: null, timedOut: true }, undefined)).toMatchObject({ status: 'error', diagnosis: 'probe-timeout' });
        expect(classifyAuthStatus({ stdout: 'nope', exitCode: 2, timedOut: false }, undefined)).toMatchObject({ status: 'error', diagnosis: 'probe-crash' });
        expect(classifyAuthStatus({ stdout: '', exitCode: null, timedOut: false, spawnError: 'EACCES' }, undefined)).toMatchObject({ status: 'error', diagnosis: 'probe-crash' });
    });
    it('tolerates a leading warning line before the JSON', () => {
        expect(classifyAuthStatus({ stdout: 'Warning: x\n' + LOGGED_IN, exitCode: 0, timedOut: false }, undefined).status).toBe('ok');
    });
});

describe('resolveSdkClaudeBinary', () => {
    it('uses the SDK platform package and never falls back to PATH', () => {
        const seen: string[] = [];
        expect(resolveSdkClaudeBinary('darwin', 'arm64', (s) => { seen.push(s); if (s.endsWith('/claude')) return '/x/claude'; throw new Error('nope'); })).toBe('/x/claude');
        expect(seen[0]).toBe('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude');
        expect(resolveSdkClaudeBinary('linux', 'x64', () => { throw new Error('nope'); })).toBeNull();
    });
});

describe('interpretSecurityRead', () => {
    it('maps exit codes exactly like Claude Code', () => {
        expect(interpretSecurityRead({ exitCode: 44, stdout: '' })).toEqual({ kind: 'absent' });
        expect(interpretSecurityRead({ exitCode: 36, stdout: '' })).toEqual({ kind: 'unreadable' });
        expect(interpretSecurityRead({ exitCode: 0, stdout: '' })).toEqual({ kind: 'absent' });
        expect(interpretSecurityRead({ exitCode: 1, stdout: '' })).toMatchObject({ kind: 'error' });
        expect(interpretSecurityRead({ exitCode: null, stdout: '', error: 'ENOENT' })).toEqual({ kind: 'unsupported' });
    });
    it('parses an empty-token item', () => {
        const raw = '{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0}}';
        expect(interpretSecurityRead({ exitCode: 0, stdout: raw + '\n' })).toEqual({ kind: 'present', accessToken: '', refreshToken: '', raw });
    });
});

describe('diagnoseStores', () => {
    const file = (hasTokens: boolean, refresh = 'r1') => ({ exists: true, hasTokens, refreshToken: hasTokens ? refresh : '' });
    it('keychain-empty-item only when all three conditions hold', () => {
        const empty = { kind: 'present' as const, accessToken: '', refreshToken: '', raw: '{}' };
        expect(diagnoseStores({ status: 'not-logged-in', keychain: empty, file: file(true) })).toMatchObject({ diagnosis: 'keychain-empty-item', repairable: 'delete-empty-keychain-item' });
        expect(diagnoseStores({ status: 'ok', keychain: empty, file: file(true) }).diagnosis).toBeUndefined();
        expect(diagnoseStores({ status: 'not-logged-in', keychain: empty, file: file(false) }).diagnosis).toBeUndefined();
    });
    it('store-divergence when both have different refresh tokens', () => {
        const kc = { kind: 'present' as const, accessToken: 'a', refreshToken: 'r2', raw: '{}' };
        expect(diagnoseStores({ status: 'ok', keychain: kc, file: file(true, 'r1') }).diagnosis).toBe('store-divergence');
        expect(diagnoseStores({ status: 'ok', keychain: kc, file: file(true, 'r2') }).diagnosis).toBeUndefined();
    });
    it('no-credentials when keychain absent/unreadable and file has no tokens', () => {
        expect(diagnoseStores({ status: 'not-logged-in', keychain: { kind: 'absent' }, file: file(false) }).diagnosis).toBe('no-credentials');
        expect(diagnoseStores({ status: 'not-logged-in', keychain: { kind: 'unreadable' }, file: interpretCredentialsFile(null) }).diagnosis).toBe('no-credentials');
        expect(diagnoseStores({ status: 'not-logged-in', keychain: { kind: 'unreadable' }, file: file(true) })).toEqual({ detail: expect.stringContaining('cannot read the keychain') });
    });
});

describe('lineage + launchctl', () => {
    it('launchd only when env matches and job pid is an ancestor', () => {
        const env = { XPC_SERVICE_NAME: 'com.mereith.happy-daemon' };
        expect(classifyLineage({ platform: 'darwin', env, launchdJobPid: 100, ancestorPids: [1, 100, 200] })).toBe('launchd');
        expect(classifyLineage({ platform: 'darwin', env, launchdJobPid: 100, ancestorPids: [1, 300] })).toBe('inherited-env');
        expect(classifyLineage({ platform: 'darwin', env, launchdJobPid: null, ancestorPids: [1] })).toBe('inherited-env');
        expect(classifyLineage({ platform: 'darwin', env: {}, launchdJobPid: 100, ancestorPids: [100] })).toBe('other');
        expect(classifyLineage({ platform: 'linux', env, launchdJobPid: 100, ancestorPids: [100] })).toBe('other');
    });
    it('parses pid from launchctl print', () => {
        expect(parseLaunchctlPid('com.mereith.happy-daemon = {\n\tactive count = 1\n\tpath = x\n\tstate = running\n\n\tpid = 29871\n')).toBe(29871);
        expect(parseLaunchctlPid('state = not running')).toBeNull();
    });
});

describe('state assembly', () => {
    it('ignores checkedAt when comparing', () => {
        const a = buildClaudeAuthState({ daemonPid: 1, platform: 'darwin', lineage: 'other', credentialStore: 'auto', classification: { status: 'ok' }, now: 1 });
        const b = { ...a, checkedAt: 2 };
        expect(claudeAuthStateChanged(a, b)).toBe(false);
        expect(claudeAuthStateChanged(a, { ...b, status: 'error' })).toBe(true);
        expect(claudeAuthStateChanged(null, a)).toBe(true);
    });
    it('PATH gets the shim first, once', () => {
        expect(withKeychainOffPath('/usr/bin:/bin', '/lib/scripts/shims/keychain-off')).toBe('/lib/scripts/shims/keychain-off:/usr/bin:/bin');
        expect(withKeychainOffPath('/lib/scripts/shims/keychain-off:/usr/bin', '/lib/scripts/shims/keychain-off')).toBe('/lib/scripts/shims/keychain-off:/usr/bin');
    });
});
