/**
 * Daemon-side glue for agent home directories (B-478). The pure rules live in
 * `agentHomes.ts`; this file owns the cache, the disk probes and the one
 * side effect: keeping the daemon's own `process.env` in line with what the
 * user's shell exports, so every existing `process.env` consumer
 * (`getProjectPath`, the SDK, `codex app-server`, the sandbox deny list, tmux
 * terminals) sees the same directory without being taught about this module.
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

import { logger } from '@/ui/logger';
import { readSettings } from '@/persistence';

import {
    agentHomeCandidates,
    agentHomeEnv,
    describeAgentHome,
    findClaudeConversation,
    findCodexThread,
    resolveAgentHomes,
    AGENT_HOME_ENV_NAMES,
    CLAUDE_CONFIG_DIR_ENV,
    CODEX_HOME_ENV,
    type AgentHomes,
    type ConversationHit,
    type EnvLike,
    type ResolveAgentHomesInput,
} from './agentHomes';
import { probeLoginShellEnv } from './loginShellEnv';

export * from './agentHomes';
export { probeLoginShellEnv } from './loginShellEnv';

/** How long a login-shell answer is trusted before the next spawn re-asks. */
export const AGENT_HOME_CACHE_MS = 60_000;
/** A shell that could not be probed is not retried on every spawn. */
export const AGENT_HOME_FAILURE_CACHE_MS = 5 * 60_000;

interface CacheEntry {
    input: ResolveAgentHomesInput;
    homes: AgentHomes;
    expiresAt: number;
}

let cache: CacheEntry | null = null;
let inFlight: Promise<CacheEntry> | null = null;
/** The daemon env BEFORE this module ever touched it — the real "source 3". */
let originalDaemonEnv: EnvLike | null = null;

function snapshotDaemonEnv(): EnvLike {
    if (!originalDaemonEnv) {
        originalDaemonEnv = {};
        for (const name of AGENT_HOME_ENV_NAMES) originalDaemonEnv[name] = process.env[name];
    }
    return originalDaemonEnv;
}

async function load(now: number): Promise<CacheEntry> {
    const settings = await readSettings();
    const loginShellEnv = await probeLoginShellEnv(AGENT_HOME_ENV_NAMES);
    const input: ResolveAgentHomesInput = {
        settings: { claudeConfigDir: settings.claudeConfigDir, codexHome: settings.codexHome },
        daemonEnv: snapshotDaemonEnv(),
        loginShellEnv,
        homeDir: homedir(),
    };
    const homes = resolveAgentHomes(input);
    return {
        input,
        homes,
        expiresAt: now + (loginShellEnv ? AGENT_HOME_CACHE_MS : AGENT_HOME_FAILURE_CACHE_MS),
    };
}

/**
 * Resolve (cached) and apply to `process.env`. Call at daemon start and right
 * before every spawn; the second and later calls are free within the cache
 * window. Logs only when the answer changes.
 */
export async function refreshAgentHomes(now: number = Date.now()): Promise<AgentHomes> {
    if (cache && cache.expiresAt > now) return cache.homes;
    if (!inFlight) {
        inFlight = load(now).finally(() => { inFlight = null; });
    }
    let entry: CacheEntry;
    try {
        entry = await inFlight;
    } catch (error) {
        // Never let a probe problem block a spawn: keep the previous answer,
        // or behave exactly like before this module existed (daemon env only).
        logger.debug('[AGENT HOME] resolve failed, falling back', error);
        if (cache) return cache.homes;
        const input: ResolveAgentHomesInput = { settings: {}, daemonEnv: snapshotDaemonEnv(), loginShellEnv: null, homeDir: homedir() };
        return resolveAgentHomes(input);
    }
    const previous = cache?.homes;
    cache = entry;
    applyAgentHomesToProcessEnv(entry.homes);
    if (!previous
        || previous.claudeConfigDir.path !== entry.homes.claudeConfigDir.path
        || previous.codexHome.path !== entry.homes.codexHome.path) {
        logger.debug(`[AGENT HOME] Claude config dir: ${describeAgentHome(entry.homes.claudeConfigDir)}; Codex home: ${describeAgentHome(entry.homes.codexHome)}`);
    }
    return entry.homes;
}

/** The last resolved answer without probing; `null` before the first refresh. */
export function currentAgentHomes(): AgentHomes | null {
    return cache?.homes ?? null;
}

/** Drop the cache and the daemon-env snapshot (settings changed, tests). */
export function resetAgentHomesCache(): void {
    cache = null;
    inFlight = null;
    originalDaemonEnv = null;
}

function applyAgentHomesToProcessEnv(homes: AgentHomes): void {
    const overlay = agentHomeEnv(homes);
    for (const name of AGENT_HOME_ENV_NAMES) {
        const next = overlay[name];
        if (next === undefined) {
            // Resolved to the provider default: only clear a value THIS module
            // set earlier; a variable the daemon was started with stays.
            const original = snapshotDaemonEnv()[name];
            if (original === undefined) delete process.env[name];
            else process.env[name] = original;
        } else if (process.env[name] !== next) {
            process.env[name] = next;
        }
    }
}

function listDirSafe(path: string): string[] {
    try { return readdirSync(path); } catch { return []; }
}

function fileSizeSafe(path: string): number | null {
    try {
        const st = statSync(path);
        return st.isFile() ? st.size : null;
    } catch { return null; }
}

/**
 * Where is this Claude conversation? Checks the resolved directory first,
 * then every other place the user might have pointed a shell at. Sync so the
 * existing `conversationExists` prechecks can use it as a drop-in.
 */
export function locateClaudeConversation(workingDirectory: string, claudeSessionId: string): ConversationHit | null {
    const entry = cache;
    if (!entry) {
        // Before the first refresh only the daemon env is known — same answer
        // `getProjectPath` would give.
        const input: ResolveAgentHomesInput = { settings: {}, daemonEnv: process.env, loginShellEnv: null, homeDir: homedir() };
        return findClaudeConversation(claudeSessionId, workingDirectory, agentHomeCandidates('claude', input), fileSizeSafe);
    }
    return findClaudeConversation(claudeSessionId, workingDirectory, agentHomeCandidates('claude', entry.input, entry.homes), fileSizeSafe);
}

export function locateCodexThread(codexThreadId: string): ConversationHit | null {
    const entry = cache;
    const input: ResolveAgentHomesInput = entry?.input
        ?? { settings: {}, daemonEnv: process.env, loginShellEnv: null, homeDir: homedir() };
    return findCodexThread(codexThreadId, agentHomeCandidates('codex', input, entry?.homes), listDirSafe);
}

export interface SpawnEnvForResumeInput {
    workingDirectory: string;
    claudeSessionId?: string | null;
    codexThreadId?: string | null;
}

/**
 * Per-spawn env overlay for a resume: when the conversation was found in a
 * directory other than the resolved one, point that one spawn at it — exactly
 * what the user's `CLAUDE_CONFIG_DIR=… claude --resume` would do. Empty when
 * nothing needs overriding (or nothing was found: the normal missing-
 * conversation path then reports as before).
 */
export function agentHomeSpawnEnv(input: SpawnEnvForResumeInput): Record<string, string> {
    const env: Record<string, string> = {};
    if (input.claudeSessionId) {
        const hit = locateClaudeConversation(input.workingDirectory, input.claudeSessionId);
        if (hit && !hit.resolved) {
            env[CLAUDE_CONFIG_DIR_ENV] = hit.home;
            logger.debug(`[AGENT HOME] Claude conversation ${input.claudeSessionId} found under ${hit.home}; overriding ${CLAUDE_CONFIG_DIR_ENV} for this spawn`);
        }
    }
    if (input.codexThreadId) {
        const hit = locateCodexThread(input.codexThreadId);
        if (hit && !hit.resolved) {
            env[CODEX_HOME_ENV] = hit.home;
            logger.debug(`[AGENT HOME] Codex thread ${input.codexThreadId} found under ${hit.home}; overriding ${CODEX_HOME_ENV} for this spawn`);
        }
    }
    return env;
}
