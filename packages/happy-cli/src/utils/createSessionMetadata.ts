/**
 * Session Metadata Factory
 *
 * Creates session state and metadata objects for all backends (Claude, Codex, Gemini).
 * This follows DRY principles by providing a single implementation for all backends.
 *
 * @module createSessionMetadata
 */

import os from 'node:os';
import { resolve } from 'node:path';

import type { AgentState, Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import type { SandboxConfig } from '@/persistence';
import packageJson from '../../package.json';

/**
 * Backend flavor identifier for session metadata.
 */
export type BackendFlavor = 'claude' | 'codex' | 'gemini' | 'opencode' | 'openclaw' | 'acp';

/**
 * Options for creating session metadata.
 */
export interface CreateSessionMetadataOptions {
    /** Backend flavor (claude, codex, gemini) */
    flavor: BackendFlavor;
    /** Machine ID for server identification */
    machineId: string;
    /** How the session was started */
    startedBy?: 'daemon' | 'terminal';
    /** Active sandbox config for the session, or undefined when not used */
    sandbox?: SandboxConfig;
    /** Whether the backend runs with "dangerously skip permissions" behavior */
    dangerouslySkipPermissions?: boolean;
    /** Happy session id this session was forked from. */
    parentSessionId?: string;
    /** Happy message id used as the fork rewind point. */
    forkedFromMessageId?: string;
}

/**
 * Result containing both state and metadata for session creation.
 */
export interface SessionMetadataResult {
    /** Agent state for session */
    state: AgentState;
    /** Session metadata */
    metadata: Metadata;
}

/**
 * Max length of a spawn-origin tag. Long enough for 'assistant' and adapter
 * names like 'tanka'/'cron-nightly'; short enough to stay a chip in the web UI.
 */
const SPAWN_ORIGIN_TAG_MAX = 24;

/**
 * B-091 / B-303: initial tags derived from the session's spawn origin.
 *
 * The daemon's spawn RPC exports HAPPY_SPAWNED_BY (B-069) from the caller's
 * `spawnedBy`; the session is then born carrying that origin as its tag, so
 * every list shows where the work came from. Originally (B-091) this only
 * understood the literal 'assistant'. B-303 generalised it because external
 * adapters — an IM bridge, a scheduler — need the same legibility, and
 * `very-happy spawn --spawned-by <name>` now lets them set it.
 *
 * Why generalising is safe: nothing in this repo sets `spawnedBy` except the
 * assistant's own session_spawn, so no existing spawn path changes behaviour.
 * 'assistant' keeps producing exactly ['assistant'].
 *
 * The Claude meta-agent singleton (flavor 'claude' + HAPPY_SESSION_VARIANT=
 * assistant, see daemon/assistantSpawn.ts `claude-singleton`) is NOT tagged —
 * it is the variant and never joins the lists at all. Every other flavor with
 * that variant is an `env-only` spawn (pi/codex meta-agents): it DOES appear
 * in `sessions list`, so it keeps its origin tag like any dispatched session.
 *
 * The value IS the tag, so it is validated as a display-safe slug
 * (lowercase alphanumerics plus '-'/'_', <= 24 chars). Anything else yields no
 * tag rather than a malformed chip. Pure over `env` for unit tests.
 */
export function spawnOriginTags(
    env: Record<string, string | undefined> = process.env,
    flavor: BackendFlavor | undefined = undefined,
): string[] | undefined {
    if (env.HAPPY_SESSION_VARIANT === 'assistant' && flavor === 'claude') return undefined;
    const origin = (env.HAPPY_SPAWNED_BY ?? '').trim();
    if (!origin) return undefined;
    if (origin.length > SPAWN_ORIGIN_TAG_MAX) return undefined;
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(origin)) return undefined;
    return [origin];
}

/**
 * Is `value` usable as a spawn origin (and therefore as the session's origin
 * tag)? Shared with the CLI so `very-happy spawn --spawned-by` rejects a bad
 * value up front instead of silently producing an untagged session.
 */
export function isValidSpawnOrigin(value: string): boolean {
    return spawnOriginTags({ HAPPY_SPAWNED_BY: value }) !== undefined;
}

/**
 * Creates session state and metadata for backend agents.
 *
 * This utility consolidates the common session metadata creation logic used by
 * Codex and Gemini backends, ensuring consistency across all backend implementations.
 *
 * @param opts - Options specifying flavor, machineId, and startedBy
 * @returns Object containing state and metadata for session creation
 *
 * @example
 * ```typescript
 * const { state, metadata } = createSessionMetadata({
 *     flavor: 'gemini',
 *     machineId: settings.machineId,
 *     startedBy: opts.startedBy
 * });
 *
 * const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
 * ```
 */
export function createSessionMetadata(opts: CreateSessionMetadataOptions): SessionMetadataResult {
    const state: AgentState = {
        controlledByUser: false,
    };

    const originTags = spawnOriginTags(process.env, opts.flavor);

    const metadata: Metadata = {
        path: process.cwd(),
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: opts.machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: opts.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: opts.startedBy || 'terminal',
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: opts.flavor,
        sandbox: opts.sandbox?.enabled ? opts.sandbox : null,
        dangerouslySkipPermissions: opts.dangerouslySkipPermissions ?? null,
        ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
        ...(opts.forkedFromMessageId ? { forkedFromMessageId: opts.forkedFromMessageId } : {}),
        // B-091/B-303: dispatched sessions carry their spawn origin as a tag
        // from birth (see spawnOriginTags) — applies to every flavor the daemon
        // can spawn, since HAPPY_SPAWNED_BY is exported flavor-independently.
        ...(originTags ? { tags: originTags } : {}),
    };

    return { state, metadata };
}
