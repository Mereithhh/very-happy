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
 * B-091: initial tags for a session dispatched BY the assistant. The daemon's
 * spawn RPC exports HAPPY_SPAWNED_BY (B-069); such sessions are born with the
 * 'assistant' tag so every list shows their origin. The meta-agent itself
 * (HAPPY_SESSION_VARIANT=assistant) is NOT tagged — it is the variant and
 * never joins the lists at all. Pure over `env` for unit tests.
 */
export function assistantSpawnTags(env: Record<string, string | undefined> = process.env): string[] | undefined {
    if (env.HAPPY_SPAWNED_BY !== 'assistant') return undefined;
    if (env.HAPPY_SESSION_VARIANT === 'assistant') return undefined;
    return ['assistant'];
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

    const assistantTags = assistantSpawnTags();

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
        // B-091: assistant-dispatched sessions carry the 'assistant' tag from
        // birth (see assistantSpawnTags) — applies to every flavor the daemon
        // can spawn, since HAPPY_SPAWNED_BY is exported flavor-independently.
        ...(assistantTags ? { tags: assistantTags } : {}),
    };

    return { state, metadata };
}
