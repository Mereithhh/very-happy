/**
 * Directory validation for the assistant's session_spawn tool — B-051 C4.
 *
 * The daemon happily `mkdir -p`s whatever path it receives, so a relative or
 * "~"-prefixed directory coming from the model would silently create garbage
 * folders relative to the daemon's cwd (e.g. `./~/code`). Normalize and
 * validate here, BEFORE anything reaches the daemon: a leading `~` expands
 * to the home directory; anything that still isn't absolute is a tool error.
 */

import { isAbsolute, join, normalize } from 'node:path'

export type SpawnDirectoryResult =
    | { ok: true; directory: string }
    | { ok: false; error: string }

export function normalizeSpawnDirectory(input: string, homeDir: string): SpawnDirectoryResult {
    const trimmed = typeof input === 'string' ? input.trim() : ''
    if (trimmed.length === 0) {
        return { ok: false, error: 'directory is required' }
    }

    let expanded = trimmed
    if (trimmed === '~') {
        expanded = homeDir
    } else if (trimmed.startsWith('~/')) {
        expanded = join(homeDir, trimmed.slice(2))
    } else if (trimmed.startsWith('~')) {
        // "~user" expansion is not supported — refuse rather than guess.
        return { ok: false, error: `Unsupported "~user" path: ${trimmed}. Use an absolute path.` }
    }

    if (!isAbsolute(expanded)) {
        return { ok: false, error: `directory must be an absolute path (got "${trimmed}")` }
    }
    return { ok: true, directory: normalize(expanded) }
}
