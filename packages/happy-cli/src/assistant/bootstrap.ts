/**
 * Assistant home bootstrap — B-051.
 *
 * The assistant (meta-agent) session always runs with cwd
 * `~/.happy/assistant/`. On first spawn we lay down:
 *
 *   assistant/
 *     CLAUDE.md            ← role definition (templates.ts)
 *     memory/personal.md   ← long-term personal memory (memory_update target)
 *     memory/journal/      ← daily append-only journals
 *
 * Idempotent by construction: directories are `mkdir -p`-style, files are
 * only written when absent. Existing files are NEVER overwritten — after the
 * first bootstrap they belong to the user / the assistant itself.
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configuration } from '@/configuration'
import { ASSISTANT_CLAUDE_MD, ASSISTANT_PERSONAL_MD } from './templates'

/** Absolute path of the assistant home (`~/.happy/assistant`). */
export function assistantHome(): string {
    return join(configuration.happyHomeDir, 'assistant')
}

/** Absolute path of the assistant's personal memory file. */
export function assistantPersonalMemoryPath(home: string = assistantHome()): string {
    return join(home, 'memory', 'personal.md')
}

/**
 * Ensure the assistant home exists with its seed files. Returns the list of
 * paths this call actually created (empty on an already-bootstrapped home).
 */
export async function bootstrapAssistantHome(home: string = assistantHome()): Promise<{ home: string; created: string[] }> {
    const created: string[] = []

    const journalDir = join(home, 'memory', 'journal')
    await mkdir(journalDir, { recursive: true })

    const claudeMdPath = join(home, 'CLAUDE.md')
    if (!existsSync(claudeMdPath)) {
        await writeFile(claudeMdPath, ASSISTANT_CLAUDE_MD, 'utf8')
        created.push(claudeMdPath)
    }

    const personalPath = assistantPersonalMemoryPath(home)
    if (!existsSync(personalPath)) {
        await writeFile(personalPath, ASSISTANT_PERSONAL_MD, 'utf8')
        created.push(personalPath)
    }

    return { home, created }
}
