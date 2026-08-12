import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapAssistantHome, assistantPersonalMemoryPath } from './bootstrap'

let home: string

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'vh-assistant-test-'))
})

afterEach(async () => {
    await rm(home, { recursive: true, force: true })
})

describe('bootstrapAssistantHome', () => {
    it('creates CLAUDE.md, memory/personal.md and memory/journal/ on first run', async () => {
        const { created } = await bootstrapAssistantHome(home)
        expect(created).toContain(join(home, 'CLAUDE.md'))
        expect(created).toContain(join(home, 'memory', 'personal.md'))

        const claudeMd = await readFile(join(home, 'CLAUDE.md'), 'utf8')
        expect(claudeMd).toContain('调度中心')
        const personal = await readFile(assistantPersonalMemoryPath(home), 'utf8')
        expect(personal).toContain('## 身份与偏好')
        expect((await stat(join(home, 'memory', 'journal'))).isDirectory()).toBe(true)
    })

    it('never overwrites existing files (idempotent)', async () => {
        await bootstrapAssistantHome(home)
        await writeFile(join(home, 'CLAUDE.md'), 'USER OWNED', 'utf8')
        await writeFile(assistantPersonalMemoryPath(home), 'MY MEMORY', 'utf8')

        const { created } = await bootstrapAssistantHome(home)
        expect(created).toEqual([])
        expect(await readFile(join(home, 'CLAUDE.md'), 'utf8')).toBe('USER OWNED')
        expect(await readFile(assistantPersonalMemoryPath(home), 'utf8')).toBe('MY MEMORY')
    })
})
