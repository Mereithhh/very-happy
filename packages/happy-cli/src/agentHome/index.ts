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
/**
 * B-512: a new-session spawn serves an expired login-shell answer (and
 * re-probes in the background) instead of waiting up to 3 s for the shell —
 * but never one older than this; then it waits like every other caller.
 */
export const AGENT_HOME_MAX_STALE_MS = 10 * 60_000;

interface ShellProbeEntry {
    env: EnvLike | null;
    probedAt: number;
    ttlMs: number;
}

export type ShellProbeDecision = 'use-cached' | 'use-stale-and-revalidate' | 'await-probe';

/**
 * B-512: what a caller does with the cached login-shell probe. Pure.
 * `allowStale` is only for new-session spawns; daemon start and the
 * resume/restart paths keep the old contract (cached within the TTL, else wait).
 */
export function decideShellProbe(
    entry: { probedAt: number; ttlMs: number } | null,
    now: number,
    allowStale: boolean,
): ShellProbeDecision {
    if (!entry) return 'await-probe';
    const age = now - entry.probedAt;
    if (age < entry.ttlMs) return 'use-cached';
    if (allowStale && age < AGENT_HOME_MAX_STALE_MS) return 'use-stale-and-revalidate';
    return 'await-probe';
}

let shellProbe: ShellProbeEntry | null = null;
let shellProbeInFlight: Promise<ShellProbeEntry> | null = null;
/** The last resolution: its inputs (for the conversation lookups) and answer. */
let last: { input: ResolveAgentHomesInput; homes: AgentHomes } | null = null;
/** The daemon env BEFORE this module ever touched it — the real "source 3". */
let originalDaemonEnv: EnvLike | null = null;

function snapshotDaemonEnv(): EnvLike {
    if (!originalDaemonEnv) {
        originalDaemonEnv = {};
        for (const name of AGENT_HOME_ENV_NAMES) originalDaemonEnv[name] = process.env[name];
    }
    return originalDaemonEnv;
}

/** One probe at a time; concurrent callers (and the background refresh) share it. */
function probeShell(now: number): Promise<ShellProbeEntry> {
    if (!shellProbeInFlight) {
        const run = probeLoginShellEnv(AGENT_HOME_ENV_NAMES).then((env) => {
            const entry: ShellProbeEntry = { env, probedAt: now, ttlMs: env ? AGENT_HOME_CACHE_MS : AGENT_HOME_FAILURE_CACHE_MS };
            shellProbe = entry;
            return entry;
        });
        shellProbeInFlight = run;
        void run.finally(() => { if (shellProbeInFlight === run) shellProbeInFlight = null; }).catch(() => { /* surfaced to awaiting callers */ });
    }
    return shellProbeInFlight;
}

async function loginShellEnvFor(now: number, allowStale: boolean): Promise<EnvLike | null> {
    const decision = decideShellProbe(shellProbe, now, allowStale);
    if (decision === 'await-probe') return (await probeShell(now)).env;
    if (decision === 'use-stale-and-revalidate') {
        // Background refresh with its own catch: an unhandled rejection in the
        // daemon must never be the price of a faster spawn.
        probeShell(now).catch((error) => logger.debug('[AGENT HOME] background login-shell probe failed', error));
    }
    return shellProbe!.env;
}

/**
 * Resolve and apply to `process.env`. Call at daemon start and right before
 * every spawn. Settings are re-read on every call (a `claudeConfigDir` change
 * applies to the next spawn); only the login-shell probe is cached — within
 * the TTL for everyone, and additionally stale-while-revalidate (up to
 * AGENT_HOME_MAX_STALE_MS) for callers passing `allowStale` (new-session
 * spawns, B-512). Logs only when the answer changes.
 */
export async function refreshAgentHomes(now: number = Date.now(), opts: { allowStale?: boolean } = {}): Promise<AgentHomes> {
    let input: ResolveAgentHomesInput;
    let homes: AgentHomes;
    try {
        const loginShellEnv = await loginShellEnvFor(now, opts.allowStale === true);
        const settings = await readSettings();
        input = {
            settings: { claudeConfigDir: settings.claudeConfigDir, codexHome: settings.codexHome },
            daemonEnv: snapshotDaemonEnv(),
            loginShellEnv,
            homeDir: homedir(),
        };
        homes = resolveAgentHomes(input);
    } catch (error) {
        // Never let a probe problem block a spawn: keep the previous answer,
        // or behave exactly like before this module existed (daemon env only).
        logger.debug('[AGENT HOME] resolve failed, falling back', error);
        if (last) return last.homes;
        return resolveAgentHomes({ settings: {}, daemonEnv: snapshotDaemonEnv(), loginShellEnv: null, homeDir: homedir() });
    }
    const previous = last?.homes;
    last = { input, homes };
    applyAgentHomesToProcessEnv(homes);
    if (!previous
        || previous.claudeConfigDir.path !== homes.claudeConfigDir.path
        || previous.codexHome.path !== homes.codexHome.path) {
        logger.debug(`[AGENT HOME] Claude config dir: ${describeAgentHome(homes.claudeConfigDir)}; Codex home: ${describeAgentHome(homes.codexHome)}`);
    }
    return homes;
}

/** The last resolved answer without probing; `null` before the first refresh. */
export function currentAgentHomes(): AgentHomes | null {
    return last?.homes ?? null;
}

/** Drop the cache and the daemon-env snapshot (settings changed, tests). */
export function resetAgentHomesCache(): void {
    shellProbe = null;
    shellProbeInFlight = null;
    last = null;
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
    const entry = last;
    if (!entry) {
        // Before the first refresh only the daemon env is known — same answer
        // `getProjectPath` would give.
        const input: ResolveAgentHomesInput = { settings: {}, daemonEnv: process.env, loginShellEnv: null, homeDir: homedir() };
        return findClaudeConversation(claudeSessionId, workingDirectory, agentHomeCandidates('claude', input), fileSizeSafe);
    }
    return findClaudeConversation(claudeSessionId, workingDirectory, agentHomeCandidates('claude', entry.input, entry.homes), fileSizeSafe);
}

export function locateCodexThread(codexThreadId: string): ConversationHit | null {
    const entry = last;
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
