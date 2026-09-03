/**
 * The backends the daemon can spawn as a remote session.
 *
 * One list, four consumers: the `spawn --agent` CLI validator, the daemon's
 * `/spawn-session` zod enum, the machine RPC `SpawnSessionOptions` type and
 * the daemon's argv switch in `daemon/run.ts`. Before this module each site
 * carried its own copy and adding a backend meant finding all of them (B-306
 * found the CLI one missing). Import from here; do not re-list.
 */
export const SPAWN_AGENTS = ['claude', 'codex', 'gemini', 'openclaw', 'pi'] as const

export type SpawnAgent = (typeof SPAWN_AGENTS)[number]

export function isSpawnAgent(value: unknown): value is SpawnAgent {
    return typeof value === 'string' && (SPAWN_AGENTS as readonly string[]).includes(value)
}
