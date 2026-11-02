/**
 * `very-happy spawn --fork <sessionId>` (B-492): the CLI counterpart of the
 * web's "fork session" (happy-web-v2 `forkAndSpawn` in sync/ops.ts).
 *
 * Same two steps, run locally instead of over the machine RPC:
 *   1. copy the source conversation — Claude: copy its JSONL
 *      (`claudeForkSession`); Codex: fork the app-server thread
 *      (`forkCodexThread`) — which yields a new provider id;
 *   2. spawn a new Happy session through the daemon with
 *      `resumeClaudeSessionId` / `resumeCodexThreadId` + `parentSessionId`,
 *      so it continues the copy and records its lineage.
 * The source must be a session this machine's daemon spawned: its metadata
 * (path, provider id, flavor) comes from `~/.happy/sessions.json`.
 *
 * `resolveForkSource` is pure (unit-tested); `forkProviderConversation` does
 * the on-disk / app-server work the daemon's `claude-fork-session` and
 * `codex-fork-thread` handlers do.
 */

import type { PersistedSession } from '@/persistence'
import { getProjectPath } from '@/claude/utils/path'
import { ForkSourceMissingError, forkCompletedTurns as claudeForkCompletedTurns, forkSession as claudeForkSession } from '@/claude/utils/claudeSessionFork'
import { CodexAppServerClient } from '@/codex/codexAppServerClient'
import { forkCodexCompletedTurns, forkCodexThread } from '@/codex/codexThreadFork'

export type ForkSource =
    | { agent: 'claude'; directory: string; claudeSessionId: string; permissionMode?: string; parentSessionId: string }
    | { agent: 'codex'; directory: string; codexThreadId: string; permissionMode?: string; parentSessionId: string }

function nonEmpty(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
}

/** Read the fork source off a persisted session; throws a user-facing error when it cannot be forked. */
export function resolveForkSource(sessionId: string, persisted: PersistedSession | undefined): ForkSource {
    if (!persisted) {
        throw new Error(`Session ${sessionId} has no local record — only sessions spawned by this machine's daemon (in the last 14 days) can be forked from here.`)
    }
    const metadata = persisted.metadata as PersistedSession['metadata'] & { codexThreadId?: string; permissionMode?: string }
    const directory = metadata?.path
    if (!nonEmpty(directory)) throw new Error(`Session ${sessionId} has no working directory in its metadata.`)
    const permissionMode = nonEmpty(metadata.permissionMode) ? metadata.permissionMode : undefined

    if (metadata.flavor === 'codex') {
        if (!nonEmpty(metadata.codexThreadId)) throw new Error(`Codex session ${sessionId} has no thread id yet (it never ran a turn) — nothing to fork.`)
        return { agent: 'codex', directory, codexThreadId: metadata.codexThreadId, permissionMode, parentSessionId: sessionId }
    }
    if (metadata.flavor && metadata.flavor !== 'claude') {
        throw new Error(`Session ${sessionId} runs ${metadata.flavor}; only claude and codex sessions can be forked.`)
    }
    if (!nonEmpty(metadata.claudeSessionId)) throw new Error(`Session ${sessionId} has no Claude conversation id yet (it never ran a turn) — nothing to fork.`)
    return { agent: 'claude', directory, claudeSessionId: metadata.claudeSessionId, permissionMode, parentSessionId: sessionId }
}

export type ForkedConversation = {
    resumeClaudeSessionId?: string
    resumeCodexThreadId?: string
    /** B-860: prompts of the source's turn in progress, left out of the copy. */
    excludedPrompts?: string[]
}

/**
 * Step 1: copy the provider conversation. Returns the resume id for the spawn.
 * B-860: while the source runs a turn (`running`), only its completed turns are
 * copied — the same daemon helpers the web's `*-fork-completed-turns` RPCs use.
 */
export async function forkProviderConversation(source: ForkSource, opts: { running?: boolean } = {}): Promise<ForkedConversation> {
    if (source.agent === 'claude') {
        try {
            const projectDir = getProjectPath(source.directory)
            if (!opts.running) return { resumeClaudeSessionId: await claudeForkSession(projectDir, source.claudeSessionId) }
            const result = await claudeForkCompletedTurns(projectDir, source.claudeSessionId)
            if ('startFresh' in result) throw new Error(NO_COMPLETED_TURN)
            return { resumeClaudeSessionId: result.newClaudeSessionId, excludedPrompts: result.excludedPrompts }
        } catch (error) {
            if (error instanceof ForkSourceMissingError) throw new Error('Claude session file not found on this machine')
            throw error
        }
    }
    const client = new CodexAppServerClient()
    await client.connect()
    try {
        if (!opts.running) {
            const result = await forkCodexThread(client, { threadId: source.codexThreadId, cwd: source.directory })
            return { resumeCodexThreadId: result.newCodexThreadId }
        }
        const result = await forkCodexCompletedTurns(client, { threadId: source.codexThreadId, cwd: source.directory })
        if ('startFresh' in result) throw new Error(NO_COMPLETED_TURN)
        return { resumeCodexThreadId: result.newCodexThreadId, excludedPrompts: result.excludedPrompts }
    } finally {
        await client.disconnect()
    }
}

const NO_COMPLETED_TURN = 'the session is running its first turn — nothing has completed yet to fork; retry once it ends.'
