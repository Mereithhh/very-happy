/**
 * B-952: what a DeepSeek Harness wrapper runs on for its session's account
 * binding. A `dsh-api` account holds a DeepSeek API key (pasted → 0600 file
 * under the Very Happy home, a key file, or an env variable of the daemon).
 * The key goes to the `dsh` child only, as DEEPSEEK_API_KEY; it is never
 * logged, never written to metadata and never sent to the server.
 *
 * As for Claude / Codex (Owner Q3): a binding that cannot be honoured never
 * falls back to the machine's own key — the wrapper refuses turns and says why.
 * An unbound session keeps the machine setup (DEEPSEEK_API_KEY in the
 * daemon's env, or dsh's own credentials store).
 */
import { readFileSync } from 'node:fs';
import type { SessionAgentProfile } from '@slopus/happy-wire';
import { DSH_API_KEY_ENV } from '@/agent/acp/dshRunner';
import { shouldRecordSpawnAccount, unavailableNotice } from './wrapperAccount';
import { accountSecretPath, expandHome, readAccounts, readSessionBindings, writeSessionBinding, type AccountsFile, type SessionAccountsFile } from './store';

export type DshAccountResolution =
    | { kind: 'machine' }
    | { kind: 'active'; id: string; profile: SessionAgentProfile; key: string }
    | { kind: 'unavailable'; id: string; profile: SessionAgentProfile };

export type DshAccountDeps = {
    home: string;
    accounts: AccountsFile;
    bindings: SessionAccountsFile;
    env: Record<string, string | undefined>;
    /** Reads a secret file; throws when it is not there. */
    readSecret: (path: string) => string;
};

/** Pure (IO injected): the dsh session's account, or the machine setup. */
export function resolveDshAccount(sessionId: string, deps: DshAccountDeps): DshAccountResolution {
    const binding = deps.bindings[sessionId];
    if (!binding || binding.account === null) return { kind: 'machine' };
    const id = binding.account;
    const record = deps.accounts.accounts[id];
    const unavailable = (label: string, kind: string, reason: string): DshAccountResolution => ({
        kind: 'unavailable', id, profile: { id, label, kind, status: 'unavailable', reason },
    });
    if (!record) return unavailable(id, 'unknown', 'missing');
    const { label, kind } = record;
    if (record.agent !== 'dsh' || kind !== 'dsh-api') return unavailable(label, kind, 'agent-mismatch');
    if (record.check?.status === 'invalid' || record.check?.status === 'expired') return unavailable(label, kind, 'invalid');
    let key: string | undefined;
    try {
        if (record.key?.source === 'stored') key = deps.readSecret(accountSecretPath(deps.home, id));
        else if (record.key?.source === 'file') key = deps.readSecret(expandHome(record.key.path));
        else if (record.key?.source === 'env') key = deps.env[record.key.name];
    } catch {
        key = undefined;
    }
    key = key?.trim();
    if (!key) return unavailable(label, kind, 'missing-secret');
    return { kind: 'active', id, profile: { id, label, kind, status: 'ok' }, key };
}

export type DshWrapperAccount = {
    /** Written to `metadata.agentProfile`. */
    profile: SessionAgentProfile | null;
    /** Merged into the dsh child's env (never the wrapper's own). */
    childEnv: Record<string, string>;
    unavailable: boolean;
    notices: string[];
};

export const MACHINE_DSH_ACCOUNT: DshWrapperAccount = { profile: null, childEnv: {}, unavailable: false, notices: [] };

export function loadDshWrapperAccount(happyHome: string, sessionId: string, spawnAccountId: string | undefined, env: NodeJS.ProcessEnv = process.env): DshWrapperAccount {
    let bindings = readSessionBindings(happyHome);
    if (shouldRecordSpawnAccount(spawnAccountId, sessionId in bindings)) {
        writeSessionBinding(happyHome, sessionId, { account: spawnAccountId! });
        bindings = { ...bindings, [sessionId]: { account: spawnAccountId! } };
    }
    const resolution = resolveDshAccount(sessionId, {
        home: happyHome,
        accounts: readAccounts(happyHome),
        bindings,
        env,
        readSecret: (path) => readFileSync(path, 'utf8'),
    });
    if (resolution.kind === 'machine') return MACHINE_DSH_ACCOUNT;
    if (resolution.kind === 'unavailable') {
        return { profile: resolution.profile, childEnv: {}, unavailable: true, notices: [unavailableNotice(resolution.profile)] };
    }
    return { profile: resolution.profile, childEnv: { [DSH_API_KEY_ENV]: resolution.key }, unavailable: false, notices: [] };
}
