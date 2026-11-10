import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyManagedSegment, MAIN_AGENT_SKILL, MANAGED_BEGIN, MANAGED_END, renderManagedSegment, writeManagedSegment, installMainAgentSkill } from './mainAgentSkill'
import { prepareMainAgent } from './gates/setup'

describe('main agent managed segment', () => {
    const segment = renderManagedSegment({ skillPaths: ['/h/.local/share/very-happy/skills/very-happy-main-agent/SKILL.md'], skillRoots: [{ path: '/srv/skills', exists: true }, { path: '/gone', exists: false }] })

    it('renders skill paths, roots and the gate summary between markers', () => {
        expect(segment.startsWith(MANAGED_BEGIN)).toBe(true)
        expect(segment.endsWith(MANAGED_END)).toBe(true)
        expect(segment).toContain('`/srv/skills`')
        expect(segment).toContain('`/gone`（不存在）')
        expect(segment).toContain('dispatch_approved')
    })

    it('appends once, then replaces only the segment and keeps user text', () => {
        const first = applyManagedSegment('# mine\n\nuser line\n', segment)!
        expect(first).toContain('user line')
        const changed = renderManagedSegment({ skillPaths: [], skillRoots: [] })
        const second = applyManagedSegment(`${first}\nafter text\n`, changed)!
        expect(second).toContain('user line')
        expect(second).toContain('after text')
        expect(second).not.toContain('/srv/skills')
        expect(second.split(MANAGED_BEGIN).length - 1).toBe(1)
    })

    it('leaves a file with a lone or reversed marker alone', () => {
        expect(applyManagedSegment(`x\n${MANAGED_BEGIN}\nno end`, segment)).toBeNull()
        expect(applyManagedSegment(`${MANAGED_END}\n${MANAGED_BEGIN}`, segment)).toBeNull()
    })

    it('writes atomically and reports unchanged on a second identical write', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'vh-seg-'))
        const path = join(dir, 'CLAUDE.md')
        await writeFile(path, '# role\n')
        expect(await writeManagedSegment(path, segment)).toBe('written')
        expect(await writeManagedSegment(path, segment)).toBe('unchanged')
        expect(await readFile(path, 'utf8')).toMatch(/^# role\n/)
    })
})

describe('main agent skill', () => {
    it('is a valid skill document naming the gate contract', () => {
        expect(MAIN_AGENT_SKILL).toMatch(/^---\nname: very-happy-main-agent\ndescription: .+\n---\n/)
        for (const word of ['risk', 'none', 'external', 'production', 'dispatch_approved', 'awaiting_decision']) expect(MAIN_AGENT_SKILL).toContain(word)
    })

    it('installs under the private managed root and is idempotent', async () => {
        const home = await mkdtemp(join(tmpdir(), 'vh-home-'))
        const path = await installMainAgentSkill(home)
        expect(path).toBe(join(home, '.local/share/very-happy/skills/very-happy-main-agent/SKILL.md'))
        expect(await readFile(path!, 'utf8')).toBe(MAIN_AGENT_SKILL)
        expect(await installMainAgentSkill(home)).toBe(path)
    })
})

describe('prepareMainAgent', () => {
    it('mounts existing skillRoots (KV ∪ local), keeps default denials when the KV is broken', async () => {
        const home = await mkdtemp(join(tmpdir(), 'vh-home-'))
        const aHome = await mkdtemp(join(tmpdir(), 'vh-assistant-'))
        const rootA = await mkdtemp(join(tmpdir(), 'vh-skills-a-'))
        await writeFile(join(aHome, 'CLAUDE.md'), '# role\n')
        await writeFile(join(aHome, 'config.json'), JSON.stringify({ skillRoots: [rootA, '/definitely/missing'], deniedTools: ['mcp__*__*archive*'] }))
        const runtime = await prepareMainAgent({ kvGet: async () => ({ value: '%%%not-base64-json' }), board: null, classify: null, approvalLink: (id) => id, home, assistantHomeDir: aHome })
        expect(runtime.extraDirectories).toEqual([join(home, '.local/share/very-happy/skills/very-happy-main-agent'), rootA])
        expect(runtime.denylist.denies('mcp__chat__send_message')).toBe(true)
        expect(runtime.denylist.denies('mcp__docs__archive_page')).toBe(true)
        const md = await readFile(join(aHome, 'CLAUDE.md'), 'utf8')
        expect(md).toContain(rootA)
        expect(md).toContain('/definitely/missing`（不存在）')
        expect(md).toContain('very-happy-main-agent/SKILL.md')

        const broken = await prepareMainAgent({ kvGet: async () => { throw new Error('offline') }, board: null, classify: null, approvalLink: (id) => id, home, assistantHomeDir: await mkdtemp(join(tmpdir(), 'vh-a2-')) })
        expect(broken.denylist.denies('mcp__chat__send_message')).toBe(true)
    })
})
