/**
 * B-850a wiring: the Claude wrapper applies the session account before any
 * Claude child exists, puts the account settings (apiKeyHelper) in every
 * --settings file it writes, refuses turns on an unusable account, and the
 * daemon passes the spawn's account and serves the RPCs. Pure parts have their
 * own tests. Source assertions, verified with scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AGENT_PROFILE_SESSION_CAPABILITY } from '@slopus/happy-wire';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\n(?:[ \t]*\n)+/g, '\n');
const claude = read('claude/runClaude.ts');
const launcher = read('claude/claudeRemoteLauncher.ts');
const daemon = read('daemon/run.ts');
const machine = read('api/apiMachine.ts');
const control = read('daemon/controlServer.ts');
const accountCmd = read('commands/account.ts');
const oneShot = read('claude/utils/titleGenerator.ts');
const between = (source: string, start: string, end: string) => {
    const at = source.indexOf(start);
    expect(at).toBeGreaterThan(-1);
    return source.slice(at, source.indexOf(end, at));
};

describe('B-850a Claude wrapper', () => {
    it('advertises the capability', () => {
        expect(AGENT_PROFILE_SESSION_CAPABILITY).toBe('agent-profile-v1');
        expect(claude).toContain('CLAUDE_CONFIG_MODEL_CAPABILITY, AGENT_PROFILE_SESSION_CAPABILITY],');
    });

    it('reads and drops the spawn account variable before anything is spawned', () => {
        expect(claude).toContain('const spawnAccountId = process.env[SPAWN_ACCOUNT_ENV] || undefined;\n    delete process.env[SPAWN_ACCOUNT_ENV];');
    });

    it('applies the account for THIS session id, pins its model and reports it', () => {
        expect(claude).toContain('account = loadWrapperAccount(configuration.happyHomeDir, response.id, spawnAccountId);');
        expect(claude).toContain('const providerPinnedModel: string | undefined = account.pinnedModel;');
        expect(claude).toContain('session.updateMetadata((current) => ({ ...current, agentProfile: account.profile }));');
        // A failed load with an intended account must not run on the machine login.
        expect(between(claude, '} catch (error) {\n        const reason', 'const providerPinnedModel')).toContain("account = spawnAccountId\n            ? { profile: { id: spawnAccountId, label: spawnAccountId, kind: 'unknown', status: 'unavailable', reason: 'error' }, settings: {}, unavailable: true");
    });

    it('every --settings file carries the account settings (main, prewarm, /btw fork)', () => {
        expect(claude).toContain('generateHookSettingsFile(hookServer.port, undefined, account.settings)');
        expect(claude).toContain('generateHookSettingsFile(hookServer.port, tag, account.settings)');
        expect(claude).toContain('writeSideQuestionSettingsFile(configuration.happyHomeDir, account.settings)');
    });

    it('an unusable account refuses each turn (not run, put back) and never prewarms', () => {
        const refuse = between(claude, 'session.onUserMessage(async (message) => {', 'titleGenerator.maybeGenerate');
        expect(refuse).toContain("if (account.unavailable && account.profile) {\n            if (message.localKey) session.sendQueueCancelReason([message.localKey], 'failed');");
        expect(refuse).toContain('return;\n        }');
        expect(between(claude, 'const createPrewarm = () => {', 'claudePrewarmEligibility({')).toContain('if (account.unavailable) return null;');
    });

    it('one-shots (title, board) carry the account settings, or they would use the machine login against the account URL', () => {
        expect(oneShot).toContain('child = spawn(binary, [...oneShotArgs(accountClaudeSettings()), prompt], {');
    });

    it('a mid-run 401 with an account marks the account, not the machine login', () => {
        const auth = between(launcher, 'onAuthFailure: (reason: string) => {', 'onSessionReset');
        expect(auth).toContain('const accountFailure = noteAccountAuthFailure();\n                        if (accountFailure) {');
        expect(auth.indexOf('return;')).toBeLessThan(auth.indexOf('notifyDaemonClaudeAuthFailed'));
    });
});

describe('B-850a daemon', () => {
    it('resolves the spawn account for Claude and fails the spawn instead of falling back', () => {
        const spawn = between(daemon, 'let spawnAccountId: string | null = null;', 'logger.debug(`[DAEMON RUN] Environment variable keys');
        expect(spawn).toContain('delete extraEnv[SPAWN_ACCOUNT_ENV];\n        if ((options.agent ?? \'claude\') === \'claude\' && accountServiceRef) {');
        expect(spawn).toContain("spawnAccountId = accountServiceRef.resolveSpawnAccount('claude', options.agentProfileId);");
        expect(spawn).toContain("return { type: 'error', errorMessage: error instanceof Error ? error.message : String(error) };");
        expect(spawn).toContain('if (spawnAccountId) extraEnv[SPAWN_ACCOUNT_ENV] = spawnAccountId;');
        expect(spawn).toContain("if ((options.agent ?? 'claude') === 'claude' && claudeAuthStatus && !spawnAccountId) {");
    });

    it('serves the RPCs and republishes on change; the connect snapshot carries the list', () => {
        expect(daemon).toContain('apiMachine.setAgentProfileService(accountService);');
        expect(daemon).toContain('onChanged: () => { void apiMachine.publishAgentProfiles(); },');
        expect(daemon).toContain('watchAccountFiles(configuration.happyHomeDir, () => { void apiMachine.publishAgentProfiles(); });');
        expect(machine).toContain('...(this.agentProfileService ? { agentProfiles: this.agentProfileService.state() } : {}),');
        expect(machine).toContain("...(agentProfileId === null || typeof agentProfileId === 'string' ? { agentProfileId } : {})");
    });

    it('account restarts have their own count, never the crash-loop breaker of 3 (A2: 4th bind hit restart-limit)', () => {
        expect(daemon).toContain('const counts = options?.account ? accountRestartCounts : restartCounts;');
        expect(daemon).toContain('decideRestart(prior, options?.account ? DEFAULT_MAX_ACCOUNT_RESTARTS : DEFAULT_MAX_RESTARTS);');
        expect(daemon).toContain('if (!options?.auto) counts.set(happySessionId, recordRestartAttempt(prior));');
        // RPC bind / rm --force, and the local route behind `account bind` / `session provider`.
        expect(daemon).toContain('const result = await restartSession(sessionId, { keepPublishedPermissionMode: true, account: true });');
        expect(control).toContain('const result = await restartSession(sessionId, { keepPublishedPermissionMode: true, account: true });');
    });

    it('a failed restart reports whether the old wrapper still runs (bind then rolls back)', () => {
        expect(daemon).toContain('const stillRunning = [...pidToTrackedSession.values()].some((s) => s.happySessionId === sessionId && isPidAlive(s.pid));\n        return { ok: false, notRunning: error.startsWith(\'restart-precheck:not-tracked\'), stillRunning, error };');
        expect(accountCmd).toContain('return { ok: false as const, notRunning: /not-tracked|not running|daemon/i.test(error), stillRunning, error };');
    });
});
