/**
 * B-850b wrapper side for Codex: resolve the session's account once at
 * startup (codexAccount.ts), strip inherited provider keys from the wrapper
 * env, prepare the ChatGPT overlay, and hand the app-server client its
 * overrides.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SessionAgentProfile } from '@slopus/happy-wire';
import { baseCodexHome, readCodexProviders } from './codexConfig';
import { resolveCodexAccount } from './codexAccount';
import { syncCodexOverlay } from './codexHome';
import { shouldRecordSpawnAccount, unavailableNotice } from './wrapperAccount';
import { defaultSecretProbe, readAccounts, readAccountsFileV2, readSessionBindings, writeAccountsFile, writeSessionBinding } from './store';

export type CodexAppServerOverrides = {
    /** Set on the app-server env (CODEX_HOME for a ChatGPT account). */
    env: Record<string, string>;
    modelProvider?: string;
    /** Deep-merged into every thread/start|resume|fork `config`. */
    config?: Record<string, unknown>;
};

export type CodexWrapperAccount = {
    profile: SessionAgentProfile | null;
    overrides: CodexAppServerOverrides;
    pinnedModel?: string;
    models?: string[];
    unavailable: boolean;
    notices: string[];
    cleanup: () => void;
};

export const MACHINE_CODEX_ACCOUNT: CodexWrapperAccount = { profile: null, overrides: { env: {} }, unavailable: false, notices: [], cleanup: () => {} };

export function loadCodexWrapperAccount(happyHome: string, sessionId: string, spawnAccountId: string | undefined, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): CodexWrapperAccount {
    let bindings = readSessionBindings(happyHome);
    if (shouldRecordSpawnAccount(spawnAccountId, sessionId in bindings)) {
        writeSessionBinding(happyHome, sessionId, { account: spawnAccountId! });
        bindings = { ...bindings, [sessionId]: { account: spawnAccountId! } };
    }
    const probe = defaultSecretProbe(env);
    const resolution = resolveCodexAccount(sessionId, {
        home: happyHome,
        accounts: readAccounts(happyHome),
        bindings,
        providers: readCodexProviders(env),
        fileReadable: probe.fileReadable,
        env,
        nodePath: process.execPath,
        envKeyCopyPath: (id) => join(happyHome, 'tmp', 'accounts', `key-${process.pid}-${id}`),
    });
    if (resolution.kind === 'machine') return MACHINE_CODEX_ACCOUNT;
    let cleanup = () => {};
    if (resolution.kind === 'active' && resolution.envKeyCopy) {
        // The auth command reads a 0600 copy; the variable leaves this
        // session's env so Codex's shell / MCP / hooks cannot read it.
        const { name, path } = resolution.envKeyCopy;
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, (env[name] ?? '').trim() + '\n', { mode: 0o600 });
        chmodSync(path, 0o600);
        cleanup = () => rmSync(path, { force: true });
    }
    for (const key of resolution.unset) delete env[key];
    if (resolution.kind === 'active' && resolution.envKeyCopy) delete env[resolution.envKeyCopy.name];
    if (resolution.kind === 'unavailable') {
        return { profile: resolution.profile, overrides: { env: {} }, unavailable: true, notices: [unavailableNotice(resolution.profile)], cleanup };
    }
    const overrides: CodexAppServerOverrides = { env: {}, modelProvider: resolution.modelProvider, ...(resolution.config ? { config: resolution.config } : {}) };
    if (resolution.codexHome) {
        syncCodexOverlay(resolution.codexHome, baseCodexHome(env), now);
        overrides.env.CODEX_HOME = resolution.codexHome;
    }
    return {
        profile: resolution.profile,
        overrides,
        ...(resolution.pinnedModel ? { pinnedModel: resolution.pinnedModel } : {}),
        ...(resolution.models ? { models: resolution.models } : {}),
        unavailable: false,
        notices: [],
        cleanup,
    };
}

/**
 * Codex refused this session's account mid-run (401 / dead refresh token):
 * record it so the daemon republishes the account as expired (ChatGPT) /
 * invalid (API key). Returns the status written, or null.
 */
export function markCodexAccountRejected(happyHome: string, accountId: string, now: number = Date.now()): string | null {
    try {
        const file = readAccountsFileV2(happyHome);
        const record = file.accounts[accountId];
        if (!record || record.agent !== 'codex') return null;
        const status = record.kind === 'codex-chatgpt' ? 'expired' : 'invalid';
        if (record.check?.status === status) return status;
        record.check = { status, at: now, detail: 'rejected during a session' };
        writeAccountsFile(happyHome, file);
        return status;
    } catch {
        return null;
    }
}
