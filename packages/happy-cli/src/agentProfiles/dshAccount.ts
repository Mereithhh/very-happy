/**
 * B-952: what a DeepSeek Harness wrapper runs on for its session's account
 * binding. A `dsh-api` account holds a DeepSeek API key (pasted → 0600 file
 * under the Very Happy home, a key file, or an env variable of the daemon).
 * The key goes to the `dsh` child only, as DEEPSEEK_API_KEY; it is never
 * logged, never written to metadata and never sent to the server.
 * B-957: an account's optional Base URL (an Anthropic Messages compatible
 * gateway) goes the same way, as DEEPSEEK_BASE_URL — the dsh child only. An
 * account without one leaves the variable to the machine (unchanged).
 *
 * As for Claude / Codex (Owner Q3): a binding that cannot be honoured never
 * falls back to the machine's own key — the wrapper refuses turns and says why.
 * An unbound session keeps the machine setup (DEEPSEEK_API_KEY in the
 * daemon's env, or dsh's own credentials store).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pickMachineLoginFallback, type SessionAgentProfile } from '@slopus/happy-wire';
import { DSH_API_KEY_ENV, DSH_BASE_URL_ENV, type DshHintContext } from '@/agent/acp/dshRunner';
import { shouldRecordSpawnAccount, unavailableNotice } from './wrapperAccount';
import { accountSecretPath, defaultSecretProbe, expandHome, readAccounts, summarizeAccount, readSessionBindings, writeSessionBinding, type AccountsFile, type SessionAccountsFile } from './store';

export type DshAccountResolution =
    | { kind: 'machine' }
    | { kind: 'active'; id: string; profile: SessionAgentProfile; key: string; baseUrl?: string }
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
    return { kind: 'active', id, profile: { id, label, kind, status: 'active' }, key, ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}) };
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
    return { profile: resolution.profile, childEnv: dshChildEnv(resolution.key, resolution.baseUrl), unavailable: false, notices: [] };
}

/** Pure: what an active dsh account adds to the dsh child's env (and nothing else). */
export function dshChildEnv(key: string, baseUrl?: string): Record<string, string> {
    return { [DSH_API_KEY_ENV]: key, ...(baseUrl ? { [DSH_BASE_URL_ENV]: baseUrl } : {}) };
}

/**
 * B-957 pure: why `url` cannot be a dsh Base URL, or null. dsh itself refuses
 * anything but an http(s) root without credentials, query or fragment.
 */
export function dshBaseUrlProblem(url: string): string | null {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return 'baseUrl must be an http(s) URL'; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'baseUrl must be an http(s) URL';
    if (parsed.username || parsed.password) return 'baseUrl must not contain credentials';
    if (parsed.search || parsed.hash) return 'baseUrl must not contain a query or fragment';
    return null;
}

/**
 * B-960: does dsh's own (machine) login have a DeepSeek key here? A boolean
 * only — the value is never returned, logged or sent. dsh (0.2.2) resolves
 * DEEPSEEK_API_KEY from, in order: `<harness home>/.credentials.yaml`
 * (`refs.DEEPSEEK_API_KEY`, or the pre-`version` flat form), the launching
 * environment, `./.env`, `<harness home>/.env`; harness home = $DSH_HOME, else
 * ~/.dsh. `./.env` depends on the session's directory and is not counted.
 */
export function dshMachineLoginHasKey(env: Record<string, string | undefined>, readFile: (path: string) => string | null = readTextOrNull): boolean {
    if (env[DSH_API_KEY_ENV]?.trim()) return true;
    const dshHome = env.DSH_HOME?.trim() || join(env.HOME || homedir(), '.dsh');
    const credentials = readFile(join(dshHome, '.credentials.yaml'));
    if (credentials && /^\s*DEEPSEEK_API_KEY:[ \t]*\S/m.test(credentials)) return true;
    const dotenv = readFile(join(dshHome, '.env'));
    if (dotenv && /^\s*(?:export\s+)?DEEPSEEK_API_KEY[ \t]*=[ \t]*["']?[^\s"'#]/m.test(dotenv)) return true;
    return false;
}

function readTextOrNull(path: string): string | null {
    try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/**
 * B-960: for dsh's "no API key" — the account the user could switch this
 * machine-login session to (same rule as the daemon's fallback), so the hint
 * names it instead of asking to add one. A session on an account: nothing.
 */
export function dshHintContext(happyHome: string, account: Pick<DshWrapperAccount, 'profile'>, env: NodeJS.ProcessEnv = process.env, now = Date.now()): DshHintContext {
    if (account.profile) return {};
    try {
        const accounts = readAccounts(happyHome).accounts;
        const probe = defaultSecretProbe(env);
        const summaries = Object.entries(accounts).map(([id, record]) => summarizeAccount(happyHome, id, record, probe, now));
        const id = pickMachineLoginFallback(summaries, 'dsh');
        return { accountLabel: id ? accounts[id]?.label ?? null : null };
    } catch {
        return {};
    }
}
