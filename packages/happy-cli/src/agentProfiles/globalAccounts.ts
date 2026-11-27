/**
 * B-981 global model channels on a machine.
 *
 * The daemon fetches the channels its account may use (`GET /v1/model-channels`,
 * globalChannelSync.ts) and materializes each one as a READ-ONLY account
 * `global-<channel id>`:
 *
 *   $HAPPY_HOME_DIR/global-accounts.json             { version: 1, revision, accounts: { <id>: record } }  0600, no secrets
 *   $HAPPY_HOME_DIR/global-accounts/<channel>/secret  the channel key  0600, dir 0700
 *
 * store.ts `readAccounts` lists them next to the machine's own accounts with
 * `global: true`; the key is a `file` key, so Claude (apiKeyHelper) and Codex
 * (provider `auth` command) resolve them exactly like any API account. A
 * channel the server no longer returns is removed here — its sessions then
 * resolve to `unavailable: missing` and refuse turns (never the machine login).
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GLOBAL_ACCOUNT_ID_PREFIX, ModelChannelIdSchema, globalAccountId, type ModelChannel, type ModelChannelsResponse } from '@slopus/happy-wire';
import type { AccountRecord } from './store';

type GlobalRecordFile = {
    label: string;
    agent: 'claude' | 'codex';
    kind: 'claude-api' | 'codex-provider';
    createdAt: number;
    baseUrl: string;
    models: string[];
    contextWindows?: Record<string, number>;
    wireApi?: 'responses' | 'chat';
};

export function globalAccountsPath(home: string): string {
    return join(home, 'global-accounts.json');
}
export function globalAccountsDir(home: string): string {
    return join(home, 'global-accounts');
}
export function globalAccountSecretPath(home: string, channelId: string): string {
    if (!ModelChannelIdSchema.safeParse(channelId).success) throw new Error(`invalid channel id "${channelId}"`);
    return join(globalAccountsDir(home), channelId, 'secret');
}

export function isGlobalAccountId(id: string): boolean {
    return id.startsWith(GLOBAL_ACCOUNT_ID_PREFIX);
}

function channelIdOf(accountId: string): string | null {
    if (!isGlobalAccountId(accountId)) return null;
    const id = accountId.slice(GLOBAL_ACCOUNT_ID_PREFIX.length);
    return ModelChannelIdSchema.safeParse(id).success ? id : null;
}

/** Pure: global-accounts.json → read-only account records (malformed entries dropped). */
export function globalAccountsFromFile(home: string, raw: unknown): Record<string, AccountRecord> {
    const out: Record<string, AccountRecord> = {};
    const accounts = raw && typeof raw === 'object' ? (raw as { accounts?: unknown }).accounts : undefined;
    if (!accounts || typeof accounts !== 'object') return out;
    for (const [id, value] of Object.entries(accounts as Record<string, unknown>)) {
        const channelId = channelIdOf(id);
        if (!channelId || !value || typeof value !== 'object') continue;
        const a = value as Record<string, unknown>;
        const agent = a.agent === 'claude' || a.agent === 'codex' ? a.agent : null;
        if (!agent || typeof a.baseUrl !== 'string' || !/^https?:\/\//i.test(a.baseUrl)) continue;
        const models = Array.isArray(a.models) ? a.models.filter((m): m is string => typeof m === 'string' && m.length > 0) : [];
        if (models.length === 0) continue;
        const record: AccountRecord = {
            label: typeof a.label === 'string' && a.label.trim() ? a.label.trim() : id,
            agent,
            kind: agent === 'claude' ? 'claude-api' : 'codex-provider',
            createdAt: typeof a.createdAt === 'number' ? a.createdAt : 0,
            baseUrl: a.baseUrl.replace(/\/+$/, ''),
            models,
            key: { source: 'file', path: globalAccountSecretPath(home, channelId) },
            global: true,
        };
        if (a.contextWindows && typeof a.contextWindows === 'object') {
            const cw: Record<string, number> = {};
            for (const [m, n] of Object.entries(a.contextWindows as Record<string, unknown>)) if (typeof n === 'number' && Number.isInteger(n) && n > 0) cw[m] = n;
            if (Object.keys(cw).length > 0) record.contextWindows = cw;
        }
        if (agent === 'codex' && (a.wireApi === 'responses' || a.wireApi === 'chat')) record.wireApi = a.wireApi;
        out[id] = record;
    }
    return out;
}

function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return undefined;
    }
}

function writeFile0600(path: string, content: string, privateDirs: string[] = []): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    for (const dir of privateDirs) chmodSync(dir, 0o700);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, content, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
}

export function readGlobalRevision(home: string): string | null {
    const raw = readJson(globalAccountsPath(home));
    const revision = raw && typeof raw === 'object' ? (raw as { revision?: unknown }).revision : undefined;
    return typeof revision === 'string' ? revision : null;
}

export type MaterializeResult = { changed: boolean; added: string[]; removed: string[] };

/**
 * Writes the visible channel set (keys first, then the registry, then removes
 * whatever is no longer listed). Same revision with every key in place → no
 * write at all. A channel without a key (a Web token answer, or a server bug)
 * is skipped: it could not run anyway.
 */
export function materializeGlobalChannels(home: string, response: ModelChannelsResponse, now: number = Date.now()): MaterializeResult {
    const usable = response.channels.filter((c): c is ModelChannel & { apiKey: string } => typeof c.apiKey === 'string' && c.apiKey.trim().length > 0);
    const previous = readJson(globalAccountsPath(home));
    const previousAccounts = previous && typeof previous === 'object' && (previous as { accounts?: unknown }).accounts && typeof (previous as { accounts?: unknown }).accounts === 'object'
        ? (previous as { accounts: Record<string, { createdAt?: unknown }> }).accounts
        : {};
    const wantIds = new Set(usable.map((c) => c.id));
    const keysInPlace = usable.every((c) => existsSync(globalAccountSecretPath(home, c.id)));
    const staleDirs = listChannelDirs(home).filter((id) => !wantIds.has(id));
    if (readGlobalRevision(home) === response.revision && keysInPlace && staleDirs.length === 0 && existsSync(globalAccountsPath(home))) {
        return { changed: false, added: [], removed: [] };
    }
    const accounts: Record<string, GlobalRecordFile> = {};
    for (const c of usable) {
        const secretPath = globalAccountSecretPath(home, c.id);
        writeFile0600(secretPath, c.apiKey.trim() + '\n', [globalAccountsDir(home), dirname(secretPath)]);
        const id = globalAccountId(c.id);
        const createdAt = typeof previousAccounts[id]?.createdAt === 'number' ? previousAccounts[id].createdAt as number : now;
        accounts[id] = {
            label: c.label,
            agent: c.agent,
            kind: c.agent === 'claude' ? 'claude-api' : 'codex-provider',
            createdAt,
            baseUrl: c.baseUrl.replace(/\/+$/, ''),
            models: c.models,
            ...(c.contextWindows && Object.keys(c.contextWindows).length > 0 ? { contextWindows: c.contextWindows } : {}),
            ...(c.agent === 'codex' && c.wireApi ? { wireApi: c.wireApi } : {}),
        };
    }
    writeFile0600(globalAccountsPath(home), JSON.stringify({ version: 1, revision: response.revision, accounts }, null, 2) + '\n');
    for (const id of staleDirs) rmSync(join(globalAccountsDir(home), id), { recursive: true, force: true });
    const before = new Set(Object.keys(previousAccounts));
    const after = new Set(Object.keys(accounts));
    return {
        changed: true,
        added: [...after].filter((id) => !before.has(id)),
        removed: [...before].filter((id) => !after.has(id)),
    };
}

function listChannelDirs(home: string): string[] {
    try {
        return readdirSync(globalAccountsDir(home), { withFileTypes: true })
            .filter((d) => d.isDirectory() && ModelChannelIdSchema.safeParse(d.name).success)
            .map((d) => d.name);
    } catch {
        return [];
    }
}
