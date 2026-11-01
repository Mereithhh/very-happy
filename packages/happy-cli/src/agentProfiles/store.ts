/**
 * B-850a: machine-local account store (UI "账号", wire "agent profile").
 * Spec: specs/2026-11-session-accounts.md.
 *
 *   $HAPPY_HOME_DIR/accounts.json          v2 registry (0600, NO secrets)
 *   $HAPPY_HOME_DIR/accounts/<id>/secret   pasted key / setup-token (0600, dir 0700)
 *   $HAPPY_HOME_DIR/session-accounts.json  { <sessionId>: { account: id|null, model? } }
 *
 * B-794 compatibility (read-only): every profile in `providers.json` is listed
 * as a `claude-api` account with `legacy: true` (a v2 account with the same id
 * wins), and `session-providers.json` bindings apply to sessions that have no
 * entry in `session-accounts.json`. Neither v1 file is ever rewritten; a v2
 * entry `{ account: null }` is how a v1-bound session goes back to the machine
 * login.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentProfileSummary, AgentProfilesState } from '@slopus/happy-wire';
import { parseProvidersFile, parseSessionProvidersFile, providersPath, sessionProvidersPath } from '@/claude/providerBinding';

export type AccountKey =
    | { source: 'file'; path: string }
    | { source: 'env'; name: string }
    | { source: 'stored' };

export type AccountCheck = { status: string; at: number; detail?: string };

export type AccountRecord = {
    label: string;
    agent: 'claude';
    kind: 'claude-subscription' | 'claude-api';
    createdAt: number;
    /** claude-api */
    baseUrl?: string;
    models?: string[];
    /** B-794b: model id → real context window. */
    contextWindows?: Record<string, number>;
    /** claude-api: where the key lives. claude-subscription always uses the stored secret. */
    key?: AccountKey;
    /** claude-subscription: setup-token expiry (1 year after login). */
    expiresAt?: number;
    check?: AccountCheck;
    /** Set on entries synthesized from providers.json — never written to accounts.json. */
    legacy?: true;
};

export type AccountsFile = {
    version: 2;
    accounts: Record<string, AccountRecord>;
    defaults: Record<string, string>;
};

export type SessionAccountBinding = { account: string | null; model?: string };
export type SessionAccountsFile = Record<string, SessionAccountBinding>;

/** Daemon → new wrapper: the account this spawn starts on (the wrapper records it and drops the variable). */
export const SPAWN_ACCOUNT_ENV = 'VH_AGENT_PROFILE_ID';
export const SUBSCRIPTION_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function accountsPath(home: string): string {
    return join(home, 'accounts.json');
}
export function accountSecretPath(home: string, id: string): string {
    if (!ACCOUNT_ID_PATTERN.test(id)) throw new Error(`invalid account id "${id}"`);
    return join(home, 'accounts', id, 'secret');
}
export function sessionAccountsPath(home: string): string {
    return join(home, 'session-accounts.json');
}

export function expandHome(path: string, home: string = homedir()): string {
    return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

function readJson(path: string): unknown {
    if (!existsSync(path)) return undefined;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        // A hand-edited file with a syntax error must not take every session down.
        return undefined;
    }
}

function writeJson0600(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
}

function parseKey(raw: unknown): AccountKey | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const k = raw as Record<string, unknown>;
    if (k.source === 'file' && typeof k.path === 'string' && k.path) return { source: 'file', path: k.path };
    if (k.source === 'env' && typeof k.name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k.name)) return { source: 'env', name: k.name };
    if (k.source === 'stored') return { source: 'stored' };
    return undefined;
}

/** Pure: tolerant parse — malformed entries are dropped, never thrown. */
export function parseAccountsFile(raw: unknown): AccountsFile {
    const out: AccountsFile = { version: 2, accounts: {}, defaults: {} };
    if (!raw || typeof raw !== 'object') return out;
    const src = (raw as { accounts?: unknown }).accounts;
    if (src && typeof src === 'object') {
        for (const [id, value] of Object.entries(src as Record<string, unknown>)) {
            if (!ACCOUNT_ID_PATTERN.test(id) || !value || typeof value !== 'object') continue;
            const a = value as Record<string, unknown>;
            if (a.agent !== 'claude' || (a.kind !== 'claude-subscription' && a.kind !== 'claude-api')) continue;
            const label = typeof a.label === 'string' && a.label.trim() ? a.label.trim() : id;
            const rec: AccountRecord = { label, agent: 'claude', kind: a.kind, createdAt: typeof a.createdAt === 'number' ? a.createdAt : 0 };
            if (a.kind === 'claude-api') {
                if (typeof a.baseUrl !== 'string' || !/^https?:\/\//.test(a.baseUrl)) continue;
                const key = parseKey(a.key);
                if (!key) continue;
                rec.baseUrl = a.baseUrl.replace(/\/+$/, '');
                rec.key = key;
                if (Array.isArray(a.models)) rec.models = a.models.filter((m): m is string => typeof m === 'string' && m.length > 0);
                if (a.contextWindows && typeof a.contextWindows === 'object') {
                    const cw: Record<string, number> = {};
                    for (const [m, n] of Object.entries(a.contextWindows as Record<string, unknown>)) {
                        if (typeof n === 'number' && Number.isInteger(n) && n > 0) cw[m] = n;
                    }
                    if (Object.keys(cw).length > 0) rec.contextWindows = cw;
                }
            }
            if (typeof a.expiresAt === 'number') rec.expiresAt = a.expiresAt;
            if (a.check && typeof a.check === 'object') {
                const c = a.check as Record<string, unknown>;
                if (typeof c.status === 'string' && typeof c.at === 'number') {
                    rec.check = { status: c.status, at: c.at, ...(typeof c.detail === 'string' ? { detail: c.detail } : {}) };
                }
            }
            out.accounts[id] = rec;
        }
    }
    const defaults = (raw as { defaults?: unknown }).defaults;
    if (defaults && typeof defaults === 'object') {
        for (const [agent, id] of Object.entries(defaults as Record<string, unknown>)) {
            if (typeof id === 'string' && id) out.defaults[agent] = id;
        }
    }
    return out;
}

/** Pure: v1 providers.json profiles as read-only `claude-api` accounts. */
export function legacyAccountsFromProviders(raw: unknown): Record<string, AccountRecord> {
    const out: Record<string, AccountRecord> = {};
    for (const [id, p] of Object.entries(parseProvidersFile(raw).profiles)) {
        if (!ACCOUNT_ID_PATTERN.test(id)) continue;
        out[id] = {
            label: p.name ?? id,
            agent: 'claude',
            kind: 'claude-api',
            createdAt: 0,
            baseUrl: p.baseUrl,
            key: { source: 'file', path: p.apiKeyFile },
            ...(p.models ? { models: p.models } : {}),
            ...(p.contextWindows ? { contextWindows: p.contextWindows } : {}),
            legacy: true,
        };
    }
    return out;
}

/** Pure: v2 accounts over v1 legacy ones (same id → v2 wins). */
export function mergeAccounts(v2: AccountsFile, legacy: Record<string, AccountRecord>): AccountsFile {
    return { ...v2, accounts: { ...legacy, ...v2.accounts } };
}

/** The v2 file only (what writers edit). */
export function readAccountsFileV2(home: string): AccountsFile {
    return parseAccountsFile(readJson(accountsPath(home)));
}

/** v2 + read-only v1 view (what resolution and listing use). */
export function readAccounts(home: string): AccountsFile {
    return mergeAccounts(readAccountsFileV2(home), legacyAccountsFromProviders(readJson(providersPath(home))));
}

export function writeAccountsFile(home: string, file: AccountsFile): void {
    const accounts: Record<string, AccountRecord> = {};
    for (const [id, a] of Object.entries(file.accounts)) if (!a.legacy) accounts[id] = a;
    writeJson0600(accountsPath(home), { version: 2, accounts, defaults: file.defaults });
}

/** Pure: v2 bindings, plus v1 `{profile, model}` for sessions v2 does not mention. */
export function mergeSessionBindings(v2Raw: unknown, v1Raw: unknown): SessionAccountsFile {
    const out: SessionAccountsFile = {};
    for (const [sessionId, b] of Object.entries(parseSessionProvidersFile(v1Raw))) out[sessionId] = { account: b.profile, model: b.model };
    if (v2Raw && typeof v2Raw === 'object') {
        for (const [sessionId, b] of Object.entries(v2Raw as Record<string, unknown>)) {
            if (!b || typeof b !== 'object') continue;
            const { account, model } = b as Record<string, unknown>;
            if (account !== null && (typeof account !== 'string' || !account)) continue;
            out[sessionId] = { account: account as string | null, ...(typeof model === 'string' && model ? { model } : {}) };
        }
    }
    return out;
}

export function readSessionBindings(home: string): SessionAccountsFile {
    return mergeSessionBindings(readJson(sessionAccountsPath(home)), readJson(sessionProvidersPath(home)));
}

/** The raw v2 entry of one session (undefined = none; a v1 binding may still apply). For rollback. */
export function readSessionBindingV2(home: string, sessionId: string): SessionAccountBinding | undefined {
    const raw = readJson(sessionAccountsPath(home));
    const entry = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[sessionId] : undefined;
    return entry && typeof entry === 'object' ? entry as SessionAccountBinding : undefined;
}

/**
 * Read-modify-write of ONE session's v2 binding. `null` binding = explicit
 * machine login (shadows a v1 binding); `undefined` deletes the v2 entry.
 */
export function writeSessionBinding(home: string, sessionId: string, binding: SessionAccountBinding | undefined): void {
    const raw = readJson(sessionAccountsPath(home));
    const current: Record<string, unknown> = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
    if (binding === undefined) delete current[sessionId];
    else current[sessionId] = binding;
    writeJson0600(sessionAccountsPath(home), current);
}

/** Session ids whose effective binding names `accountId`. */
export function sessionsBoundTo(bindings: SessionAccountsFile, accountId: string): string[] {
    return Object.entries(bindings).filter(([, b]) => b.account === accountId).map(([id]) => id);
}

export function writeAccountSecret(home: string, id: string, secret: string): void {
    const path = accountSecretPath(home, id);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, secret.trim() + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
}

export function removeAccountSecret(home: string, id: string): void {
    rmSync(dirname(accountSecretPath(home, id)), { recursive: true, force: true });
}

/**
 * Pure: a fresh id from a label (ASCII slug), unique in `taken`. A label with
 * non-ASCII letters (「组织 A」) would slug to a meaningless fragment, so it
 * gets the kind instead.
 */
export function newAccountId(label: string, kind: AccountRecord['kind'], taken: Iterable<string>): string {
    const used = new Set(taken);
    const ascii = /^[\x20-\x7e]*$/.test(label);
    const slug = ascii ? label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) : '';
    const base = slug && /^[a-z0-9]/.test(slug) ? slug : kind === 'claude-subscription' ? 'claude-sub' : 'claude-api';
    if (!used.has(base)) return base;
    for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

// ---- status ----------------------------------------------------------------

export type SecretProbe = {
    fileReadable: (path: string) => boolean;
    env: Record<string, string | undefined>;
};

/** Pure: where an account's secret comes from and whether it is there right now. */
export function secretPresent(home: string, id: string, a: AccountRecord, probe: SecretProbe): boolean {
    if (a.kind === 'claude-subscription' || a.key?.source === 'stored') return probe.fileReadable(accountSecretPath(home, id));
    if (a.key?.source === 'file') return probe.fileReadable(expandHome(a.key.path));
    if (a.key?.source === 'env') return !!probe.env[a.key.name]?.trim();
    return false;
}

/**
 * Pure: the status the UI shows. Live facts (missing secret, past expiry) beat
 * the last check; otherwise the last check, or 'unverified'.
 */
export function accountStatus(home: string, id: string, a: AccountRecord, probe: SecretProbe, now: number): { status: string; detail?: string } {
    if (!secretPresent(home, id, a, probe)) return { status: 'missing-secret' };
    if (a.expiresAt !== undefined && a.expiresAt <= now) return { status: 'expired' };
    if (a.check) return { status: a.check.status, ...(a.check.detail ? { detail: a.check.detail } : {}) };
    return { status: 'unverified' };
}

export function summarizeAccount(home: string, id: string, a: AccountRecord, probe: SecretProbe, now: number): AgentProfileSummary {
    const { status, detail } = accountStatus(home, id, a, probe, now);
    const keySource = a.kind === 'claude-subscription' ? 'stored' : a.key?.source;
    const keyRef = a.key?.source === 'file' ? a.key.path : a.key?.source === 'env' ? a.key.name : undefined;
    return {
        id,
        label: a.label,
        agent: a.agent,
        kind: a.kind,
        status,
        ...(detail ? { statusDetail: detail } : {}),
        ...(a.check ? { checkedAt: a.check.at } : {}),
        ...(a.createdAt ? { createdAt: a.createdAt } : {}),
        ...(a.expiresAt !== undefined ? { expiresAt: a.expiresAt } : {}),
        ...(a.baseUrl ? { baseUrl: a.baseUrl } : {}),
        ...(a.models ? { models: a.models } : {}),
        ...(keySource ? { keySource } : {}),
        ...(keyRef ? { keyRef } : {}),
        ...(a.legacy ? { legacy: true } : {}),
    };
}

export function defaultSecretProbe(env: Record<string, string | undefined> = process.env): SecretProbe {
    return {
        fileReadable: (path) => {
            try {
                return readFileSync(path, 'utf8').trim().length > 0;
            } catch {
                return false;
            }
        },
        env,
    };
}

export function buildAgentProfilesState(home: string, file: AccountsFile, probe: SecretProbe, now: number, daemonPid: number): AgentProfilesState {
    const accounts = Object.entries(file.accounts)
        .map(([id, a]) => summarizeAccount(home, id, a, probe, now))
        .sort((x, y) => (x.createdAt ?? 0) - (y.createdAt ?? 0) || x.id.localeCompare(y.id));
    const defaults: Record<string, string> = {};
    for (const [agent, id] of Object.entries(file.defaults)) if (file.accounts[id]) defaults[agent] = id;
    return { daemonPid, updatedAt: now, accounts, defaults };
}
