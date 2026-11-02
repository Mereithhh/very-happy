/**
 * B-850b wiring: the Codex wrapper resolves the session account before the
 * app-server exists, hands the client its overrides, reports the account,
 * refuses turns on an unusable account, moves the thread to the new account's
 * model on a switch (clearing the sticky model), and the daemon resolves Codex
 * spawns too. Pure parts have their own tests. Source assertions, verified with
 * scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\n(?:[ \t]*\n)+/g, '\n');
const codex = read('codex/runCodex.ts');
const daemon = read('daemon/run.ts');

describe('B-850b Codex wrapper', () => {
    it('advertises the capability and takes the spawn account out of the env', () => {
        expect(codex).toContain('CODEX_COMPACT_CAPABILITY, RUN_INTENT_CAPABILITY, AGENT_PROFILE_SESSION_CAPABILITY, CODEX_BTW_CAPABILITY, CODEX_LIVE_PERMISSION_CAPABILITY],');
        expect(codex).toContain('const spawnAccountId = process.env[SPAWN_ACCOUNT_ENV] || undefined;\n    delete process.env[SPAWN_ACCOUNT_ENV];');
    });

    it('resolves the account for THIS session and gives the app-server client its overrides', () => {
        expect(codex).toContain('codexAccount = loadCodexWrapperAccount(configuration.happyHomeDir, response.id, spawnAccountId);');
        expect(codex).toContain('client = new CodexAppServerClient(sandboxConfig);\n    client.setAccountOverrides(codexAccount.overrides);');
    });

    it('reports metadata.agentProfile; a switch clears the sticky model and model intent', () => {
        expect(codex).toContain('agentProfile: codexAccount.profile,\n        ...(accountSwitched ? { stickyModel: null, modelIntent: null } : {}),');
        expect(codex).toContain('const accountSwitched = !!reconnectSessionId && reconnectSeeded && !!response && codexAccountSwitched(response.metadata?.agentProfile, codexAccount.profile);');
        expect(codex).toContain('...(accountSwitched && machineDefaultModel ? { model: machineDefaultModel } : {}),');
    });

    it('a new thread on an account starts on the account model, not config.toml\'s', () => {
        expect(codex).toContain('model: turnModel ?? (codexAccount.profile && !codexAccount.unavailable ? machineDefaultModel : undefined),');
    });

    it('"default" on an account is the account model; API accounts list their own models', () => {
        expect(codex).toContain('if (codexAccount.profile && !codexAccount.unavailable) {\n                machineDefaultModel = accountDefault;\n                if (codexAccount.models?.length) discoveredModels = accountModelsAsCatalog(codexAccount.models, discoveredModels);');
    });

    it('a thread recorded on an account provider resumes: back on machine login names the machine provider; unusable account skips the resume', () => {
        expect(codex).toContain('if (accountSwitched && !codexAccount.profile) codexAccount = { ...codexAccount, overrides: { env: {}, modelProvider: readCodexDefaultProvider() } };');
        expect(codex).toContain('if (opts.resumeThreadId && !codexAccount.unavailable) {');
    });

    it('refuses every turn on an unusable account (「未执行」), never runs it on the machine login', () => {
        expect(codex).toContain("if (codexAccount.unavailable && codexAccount.profile) {\n            if (message.localKey) session.sendQueueCancelReason([message.localKey], 'failed');");
    });

    it('turn failures go through the account classifier (history rejected / auth)', () => {
        expect(codex).toContain("session.sendSessionEvent({ type: 'message', message: `Codex error: ${failure}` });\n                noteAccountFailure(failure);\n            } else {\n                messageBuffer.addMessage('Task completed', 'status');");
        expect(codex).toContain("session.sendSessionEvent({ type: 'message', message: `Codex error: ${reason}` });\n                    noteAccountFailure(reason);");
        expect(codex).toContain("if (accountSwitched && !historyRejectionReported && isHistoryRejectedError(text)) {");
    });
});

describe('B-850b daemon', () => {
    it('resolves the spawn account for Codex sessions as for Claude', () => {
        expect(daemon).toContain("const accountAgent = (options.agent ?? 'claude') === 'claude' ? 'claude' : options.agent === 'codex' ? 'codex' : null;");
        expect(daemon).toContain("return flavor === 'codex' ? 'codex' : flavor === 'claude' ? 'claude' : flavor;");
    });
});
