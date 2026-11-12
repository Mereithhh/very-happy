/**
 * B-850b: the `[model_providers.*]` of the machine's Codex config — what a
 * `codex-provider` account is based on, and which env keys a bound session
 * must not inherit (B-847: the key reaches only the sessions bound to it).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

export type CodexProviderDef = {
    id: string;
    name?: string;
    baseUrl?: string;
    envKey?: string;
    /** Everything else of the table, passed through to the per-thread override. */
    table: Record<string, unknown>;
};

/** The wrapper's / daemon's Codex home (where config.toml and sessions live). */
export function baseCodexHome(env: Record<string, string | undefined> = process.env): string {
    return env.CODEX_HOME || join(homedir(), '.codex');
}

/** Pure: tolerant parse of config.toml text → providers (a syntax error = none). */
export function parseCodexProviders(text: string | undefined): CodexProviderDef[] {
    if (!text) return [];
    let doc: unknown;
    try {
        doc = parse(text);
    } catch {
        return [];
    }
    const providers = (doc as { model_providers?: unknown })?.model_providers;
    if (!providers || typeof providers !== 'object') return [];
    const out: CodexProviderDef[] = [];
    for (const [id, raw] of Object.entries(providers as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const table = raw as Record<string, unknown>;
        out.push({
            id,
            ...(typeof table.name === 'string' ? { name: table.name } : {}),
            ...(typeof table.base_url === 'string' ? { baseUrl: table.base_url } : {}),
            ...(typeof table.env_key === 'string' && table.env_key ? { envKey: table.env_key } : {}),
            table,
        });
    }
    return out;
}

/**
 * Pure: the provider a machine-login thread runs on (`model_provider` of
 * config.toml, Codex's default `openai` when unset). Needed when a thread
 * recorded on an account's `vh-<id>` provider resumes on the machine login:
 * Codex resumes on the thread's recorded provider unless told otherwise, and
 * `vh-<id>` exists only in that account's per-thread override.
 */
export function parseCodexDefaultProvider(text: string | undefined): string {
    if (!text) return 'openai';
    try {
        const value = (parse(text) as { model_provider?: unknown }).model_provider;
        return typeof value === 'string' && value ? value : 'openai';
    } catch {
        return 'openai';
    }
}

export function readCodexDefaultProvider(env: Record<string, string | undefined> = process.env): string {
    try {
        return parseCodexDefaultProvider(readFileSync(join(baseCodexHome(env), 'config.toml'), 'utf8'));
    } catch {
        return 'openai';
    }
}

export function readCodexProviders(env: Record<string, string | undefined> = process.env): CodexProviderDef[] {
    try {
        return parseCodexProviders(readFileSync(join(baseCodexHome(env), 'config.toml'), 'utf8'));
    } catch {
        return [];
    }
}

/** Fields of a provider table that carry or point at a credential: the account's `auth` command replaces them. */
const CREDENTIAL_FIELDS = new Set(['env_key', 'env_key_instructions', 'experimental_bearer_token', 'bearer_token', 'requires_openai_auth', 'auth']);

/**
 * Pure: the provider table a bound thread runs on. Codex runs `auth.command`
 * itself and sends its stdout as the bearer token (measured on 0.154: the
 * `exec_command` tool's env never sees the key; with `env_key` it does).
 */
export function buildCodexProviderTable(input: {
    base: CodexProviderDef | undefined;
    label: string;
    baseUrl?: string;
    wireApi?: 'responses' | 'chat';
    nodePath: string;
    keyPath: string;
}): Record<string, unknown> {
    const table: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.base?.table ?? {})) if (!CREDENTIAL_FIELDS.has(k)) table[k] = v;
    table.name = input.label;
    if (input.baseUrl) table.base_url = input.baseUrl;
    if (input.wireApi) table.wire_api = input.wireApi;
    else if (table.wire_api === undefined) table.wire_api = 'responses';
    table.auth = {
        command: input.nodePath,
        args: ['-e', "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8').trim())", input.keyPath],
    };
    return table;
}

/** The thread-level provider id of an account (never a built-in or config.toml id). */
export function accountProviderId(accountId: string): string {
    return `vh-${accountId}`;
}

/** Pure: a JSON-like value as a TOML inline value (what Codex's `-c key=value` parses). */
export function tomlInlineValue(value: unknown): string {
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`not a TOML number: ${value}`);
        return String(value);
    }
    if (typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return `[${value.map(tomlInlineValue).join(', ')}]`;
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null);
        return `{${entries.map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)} = ${tomlInlineValue(v)}`).join(', ')}}`;
    }
    throw new Error(`not a TOML value: ${String(value)}`);
}

/**
 * Pure (B-934): the `-c` flags that make a bound session's provider the
 * app-server's process-level provider. Codex ≥0.167 rejects a thread whose
 * `modelProvider` differs from the process's (`-32600 This chat uses …, but
 * your current provider is …`), and the process's comes from config.toml
 * unless overridden here; 0.154 accepts the same flags. The account's
 * provider table goes along so the id resolves at startup. Machine-login
 * sessions (no `modelProvider`) get none — config.toml as before.
 */
export function codexProcessProviderArgs(overrides: { modelProvider?: string; config?: Record<string, unknown> }): string[] {
    const id = overrides.modelProvider;
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return [];
    const args = ['-c', `model_provider=${JSON.stringify(id)}`];
    const table = (overrides.config?.model_providers as Record<string, unknown> | undefined)?.[id];
    if (table && typeof table === 'object') args.push('-c', `model_providers.${id}=${tomlInlineValue(table)}`);
    return args;
}
