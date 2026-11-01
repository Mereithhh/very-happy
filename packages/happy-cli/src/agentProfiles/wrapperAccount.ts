/**
 * B-850a wrapper side: resolve this session's account once at startup, apply
 * it to the wrapper's own env (every Claude child — SDK, local terminal, /btw
 * fork, prewarm — copies process.env), and remember it for the run.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SessionAgentProfile } from '@slopus/happy-wire';
import {
    applyAccountEnv,
    overridingUserSettings,
    resolveClaudeAccount,
    type ClaudeAccountResolution,
} from './claudeAccountEnv';
import { defaultSecretProbe, readAccounts, readAccountsFileV2, readSessionBindings, writeAccountsFile, writeSessionBinding } from './store';

export type WrapperAccount = {
    /** Written to `metadata.agentProfile`. */
    profile: SessionAgentProfile | null;
    /** Merged into every `--settings` file this wrapper writes (apiKeyHelper). */
    settings: Record<string, unknown>;
    pinnedModel?: string;
    /** Bound but unusable: refuse turns, never run on the machine login. */
    unavailable: boolean;
    /** One-line notices for the session (unavailable reason, overriding user settings). */
    notices: string[];
    cleanup: () => void;
};

let current: { id: string; kind: string } | null = null;
let home: string | null = null;
let currentSettings: Record<string, unknown> = {};

/**
 * The account settings every `claude` this wrapper starts must carry (the
 * SDK / local / prewarm / btw settings files, and one-shots like the title
 * generator). Empty for machine-login sessions.
 */
export function accountClaudeSettings(): Record<string, unknown> {
    return currentSettings;
}

/** Pure: why a bound account cannot run, for the chat. */
export function unavailableNotice(profile: SessionAgentProfile): string {
    const why: Record<string, string> = {
        missing: 'it no longer exists on this machine',
        'missing-secret': 'its key / token is missing on this machine',
        expired: 'its sign-in has expired — sign in again',
        invalid: 'its key was rejected — fix the key',
        'agent-mismatch': 'it belongs to another agent (Claude / Codex)',
    };
    return `Account "${profile.label}" is unavailable: ${why[profile.reason ?? ''] ?? profile.reason ?? 'unknown reason'}. This session will not fall back to the machine login; switch accounts or fix it, and the session restarts in place.`;
}

/**
 * Pure: the binding a NEW spawn records. The spawn's account only applies to a
 * session the files know nothing about yet — a reconnect of an existing
 * session keeps whatever it was bound to.
 */
export function shouldRecordSpawnAccount(spawnAccountId: string | undefined, hasBinding: boolean): boolean {
    return !!spawnAccountId && !hasBinding;
}

export function loadWrapperAccount(happyHome: string, sessionId: string, spawnAccountId: string | undefined, env: NodeJS.ProcessEnv = process.env): WrapperAccount {
    home = happyHome;
    currentSettings = {};
    let bindings = readSessionBindings(happyHome);
    if (shouldRecordSpawnAccount(spawnAccountId, sessionId in bindings)) {
        writeSessionBinding(happyHome, sessionId, { account: spawnAccountId! });
        bindings = { ...bindings, [sessionId]: { account: spawnAccountId! } };
    }
    const probe = defaultSecretProbe(env);
    const resolution: ClaudeAccountResolution = resolveClaudeAccount(sessionId, {
        home: happyHome,
        accounts: readAccounts(happyHome),
        bindings,
        fileReadable: probe.fileReadable,
        env,
        nodePath: process.execPath,
        envKeyCopyPath: (id) => join(happyHome, 'tmp', 'accounts', `key-${process.pid}-${id}`),
        readSecret: (path) => readFileSync(path, 'utf8'),
        now: Date.now(),
    });
    if (resolution.kind === 'machine') {
        current = null;
        return { profile: null, settings: {}, unavailable: false, notices: [], cleanup: () => {} };
    }
    let cleanup = () => {};
    if (resolution.kind === 'active' && resolution.envKeyCopy) {
        // The helper reads a 0600 copy; the variable itself leaves this
        // session's env so its Bash / hooks / MCP cannot read it.
        const { name, path } = resolution.envKeyCopy;
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, (env[name] ?? '').trim() + '\n', { mode: 0o600 });
        chmodSync(path, 0o600);
        delete env[name];
        cleanup = () => rmSync(path, { force: true });
    }
    applyAccountEnv(env, resolution);
    const notices: string[] = [];
    if (resolution.kind === 'unavailable') {
        current = null;
        notices.push(unavailableNotice(resolution.profile));
        return { profile: resolution.profile, settings: {}, unavailable: true, notices, cleanup };
    }
    current = { id: resolution.id, kind: resolution.profile.kind };
    currentSettings = resolution.settings;
    const overrides = overridingUserSettings(readUserClaudeSettings(env), resolution.profile.kind);
    if (overrides.length > 0) {
        notices.push(`Your Claude settings.json sets ${overrides.join(', ')}, which takes precedence over account "${resolution.profile.label}". Remove it there for the account to apply.`);
    }
    return {
        profile: resolution.profile,
        settings: resolution.settings,
        ...(resolution.pinnedModel ? { pinnedModel: resolution.pinnedModel } : {}),
        unavailable: false,
        notices,
        cleanup,
    };
}

function readUserClaudeSettings(env: NodeJS.ProcessEnv): unknown {
    const dir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    try {
        return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    } catch {
        return undefined;
    }
}

/**
 * Claude rejected this session's credential mid-run. With an account bound,
 * that is the account's problem, not the machine login's: record it so the
 * daemon republishes the account as expired/invalid, and tell the caller to
 * skip the machine-auth re-probe. Returns false for machine-login sessions.
 */
export function noteAccountAuthFailure(now: number = Date.now()): { label: string; status: string } | false {
    if (!current || !home) return false;
    const status = current.kind === 'claude-subscription' ? 'expired' : 'invalid';
    try {
        const file = readAccountsFileV2(home);
        const record = file.accounts[current.id];
        if (record) {
            record.check = { status, at: now, detail: 'rejected during a session' };
            writeAccountsFile(home, file);
            return { label: record.label, status };
        }
    } catch {
        // Best effort: the session event still tells the user.
    }
    return { label: current.id, status };
}
