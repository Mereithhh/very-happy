/**
 * B-794 v1 files, READ-ONLY since B-850a (agentProfiles/store.ts lists these
 * profiles as legacy `claude-api` accounts and honours these bindings):
 *
 *   $HAPPY_HOME_DIR/providers.json         { profiles: { <id>: { name?, baseUrl, apiKeyFile, models? } } }
 *     models[] entries are ids or { id, contextWindow } (B-794b)
 *   $HAPPY_HOME_DIR/session-providers.json { <happySessionId>: { profile, model } }
 *
 * B-794 injected the key as ANTHROPIC_AUTH_TOKEN, which the session's Bash
 * tool, hooks and stdio MCP servers all inherited; B-850a injects it through
 * apiKeyHelper instead (agentProfiles/claudeAccountEnv.ts).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ProviderProfile = {
    name?: string;
    baseUrl: string;
    apiKeyFile: string;
    models?: string[];
    /** B-794b: model id → its real context window (Claude Code assumes 200k for ids it does not know). */
    contextWindows?: Record<string, number>;
};

export type ProvidersFile = { profiles: Record<string, ProviderProfile> };
export type SessionProviderBinding = { profile: string; model: string };
export type SessionProvidersFile = Record<string, SessionProviderBinding>;

export function providersPath(happyHomeDir: string): string {
    return join(happyHomeDir, 'providers.json');
}

export function sessionProvidersPath(happyHomeDir: string): string {
    return join(happyHomeDir, 'session-providers.json');
}

export function expandHome(path: string, home: string = homedir()): string {
    return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

function readJson(path: string): unknown {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8'));
}

export function parseProvidersFile(raw: unknown): ProvidersFile {
    const profiles: Record<string, ProviderProfile> = {};
    const src = raw && typeof raw === 'object' ? (raw as { profiles?: unknown }).profiles : undefined;
    if (src && typeof src === 'object') {
        for (const [id, p] of Object.entries(src as Record<string, unknown>)) {
            if (!p || typeof p !== 'object') continue;
            const { name, baseUrl, apiKeyFile, models } = p as Record<string, unknown>;
            if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl) || typeof apiKeyFile !== 'string' || !apiKeyFile) continue;
            const ids: string[] = [];
            const contextWindows: Record<string, number> = {};
            for (const m of Array.isArray(models) ? models : []) {
                if (typeof m === 'string') ids.push(m);
                else if (m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string') {
                    const { id: modelId, contextWindow } = m as { id: string; contextWindow?: unknown };
                    ids.push(modelId);
                    if (typeof contextWindow === 'number' && Number.isInteger(contextWindow) && contextWindow > 0) contextWindows[modelId] = contextWindow;
                }
            }
            profiles[id] = {
                ...(typeof name === 'string' ? { name } : {}),
                baseUrl: baseUrl.replace(/\/+$/, ''),
                apiKeyFile,
                ...(Array.isArray(models) ? { models: ids } : {}),
                ...(Object.keys(contextWindows).length > 0 ? { contextWindows } : {}),
            };
        }
    }
    return { profiles };
}

export function parseSessionProvidersFile(raw: unknown): SessionProvidersFile {
    const out: SessionProvidersFile = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [sessionId, b] of Object.entries(raw as Record<string, unknown>)) {
        if (!b || typeof b !== 'object') continue;
        const { profile, model } = b as Record<string, unknown>;
        if (typeof profile === 'string' && profile && typeof model === 'string' && model) out[sessionId] = { profile, model };
    }
    return out;
}

export function readProviders(happyHomeDir: string): ProvidersFile {
    return parseProvidersFile(readJson(providersPath(happyHomeDir)));
}

export function readSessionProviders(happyHomeDir: string): SessionProvidersFile {
    return parseSessionProvidersFile(readJson(sessionProvidersPath(happyHomeDir)));
}
