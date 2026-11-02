import { describe, expect, it, vi } from 'vitest'
vi.mock('@/codex/codexAppServerClient', () => ({ CodexAppServerClient: class {} }))
const projectDir = vi.hoisted(() => ({ value: '' }))
vi.mock('@/claude/utils/path', () => ({ getProjectPath: () => projectDir.value }))
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forkProviderConversation, resolveForkSource } from './spawnFork'
import type { PersistedSession } from '@/persistence'

function persisted(metadata: Record<string, unknown>): PersistedSession {
    return { encryptionKey: 'k', encryptionVariant: 'dataKey', seq: 0, metadataVersion: 0, agentStateVersion: 0, savedAt: Date.now(), metadata: metadata as any }
}

describe('resolveForkSource (B-492 spawn --fork)', () => {
    it('forks a claude session from its conversation id, keeping directory and mode', () => {
        expect(resolveForkSource('s1', persisted({ path: '/w', claudeSessionId: 'c-1', permissionMode: 'plan' })))
            .toEqual({ agent: 'claude', directory: '/w', claudeSessionId: 'c-1', permissionMode: 'plan', parentSessionId: 's1' })
    })

    it('forks a codex session from its thread id', () => {
        expect(resolveForkSource('s2', persisted({ path: '/w', flavor: 'codex', codexThreadId: 't-1' })))
            .toEqual({ agent: 'codex', directory: '/w', codexThreadId: 't-1', permissionMode: undefined, parentSessionId: 's2' })
    })

    it('refuses what cannot be forked, with a reason', () => {
        expect(() => resolveForkSource('s3', undefined)).toThrow(/no local record/)
        expect(() => resolveForkSource('s4', persisted({ path: '/w' }))).toThrow(/never ran a turn/)
        expect(() => resolveForkSource('s5', persisted({ path: '/w', flavor: 'codex' }))).toThrow(/never ran a turn/)
        expect(() => resolveForkSource('s6', persisted({ path: '/w', flavor: 'gemini', claudeSessionId: 'x' }))).toThrow(/only claude and codex/)
        expect(() => resolveForkSource('s7', persisted({ claudeSessionId: 'x' }))).toThrow(/working directory/)
    })
})

describe('forkProviderConversation while the source runs (B-860)', () => {
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const source = { agent: 'claude' as const, directory: '/w', claudeSessionId: id, parentSessionId: 's1' }
    const done = [
        { type: 'user', uuid: 'u1', message: { content: 'remember ALPHA' } },
        { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' } },
    ]
    const running = [
        { type: 'user', uuid: 'u2', message: { content: 'long task' } },
        { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }], stop_reason: 'tool_use' } },
    ]
    async function withSource(entries: object[], run: () => Promise<void>) {
        projectDir.value = await mkdtemp(join(tmpdir(), 'spawn-fork-'))
        try {
            await writeFile(join(projectDir.value, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n{"type":"assis')
            await run()
        } finally {
            await rm(projectDir.value, { recursive: true, force: true })
        }
    }

    it('running: copies the completed turns and reports the prompt left out', () => withSource([...done, ...running], async () => {
        const result = await forkProviderConversation(source, { running: true })
        expect(result.excludedPrompts).toEqual(['long task'])
        const copy = (await readFile(join(projectDir.value, `${result.resumeClaudeSessionId}.jsonl`), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l))
        expect(copy).toEqual(done)
    }))

    it('idle: the whole copy, minus a torn last line', () => withSource([...done, ...running], async () => {
        const result = await forkProviderConversation(source)
        expect(result.excludedPrompts).toBeUndefined()
        const copy = (await readFile(join(projectDir.value, `${result.resumeClaudeSessionId}.jsonl`), 'utf-8')).trim().split('\n').map((l) => JSON.parse(l))
        expect(copy).toEqual([...done, ...running])
    }))

    it('running its first turn: refuses with a reason instead of an empty fork', () => withSource(running, async () => {
        await expect(forkProviderConversation(source, { running: true })).rejects.toThrow('first turn')
    }))
})
