import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPromptCacheTtlDefault, claudeSettingsPaths, CLAUDE_TTL_ENV_KEYS, decidePromptCacheTtl } from './promptCacheTtl'

const none = () => [] as unknown[]

describe('decidePromptCacheTtl (B-840)', () => {
    it('defaults to 1h for interactive, team and sticky automation sessions', () => {
        expect(decidePromptCacheTtl({}, none)).toBe('default-1h')
        expect(decidePromptCacheTtl({ HAPPY_SPAWNED_BY: 'teams', VH_TEAM_SCOPE_FILE: '/x.json' }, none)).toBe('default-1h')
        expect(decidePromptCacheTtl({ HAPPY_SPAWNED_BY: 'automation', VH_AUTOMATION_STICKY: '1' }, none)).toBe('default-1h')
    })

    it('leaves one-shot automation runs on Claude Code automatic TTL (replay: 1h costs more there)', () => {
        expect(decidePromptCacheTtl({ HAPPY_SPAWNED_BY: 'automation' }, none)).toBe('one-shot-automation')
    })

    it.each(CLAUDE_TTL_ENV_KEYS)('never overrides a user %s', (key) => {
        expect(decidePromptCacheTtl({ [key]: '5m' }, none)).toBe('user-env')
    })

    it('treats an empty env value as unset', () => {
        expect(decidePromptCacheTtl({ CLAUDE_CODE_PROMPT_CACHE_TTL: ' ' }, none)).toBe('default-1h')
    })

    it('never overrides a TTL chosen in Claude settings (keys or settings env)', () => {
        expect(decidePromptCacheTtl({}, () => [{ promptCacheTtl: '5m' }])).toBe('user-settings')
        expect(decidePromptCacheTtl({}, () => [undefined, { subagentPromptCacheTtl: '1h' }])).toBe('user-settings')
        expect(decidePromptCacheTtl({}, () => [{ env: { ENABLE_PROMPT_CACHING_1H: '1' } }])).toBe('user-settings')
        expect(decidePromptCacheTtl({}, () => [{ env: { OTHER: '1' }, model: 'opus' }, 'garbage'])).toBe('default-1h')
    })

    it('HAPPY_CLAUDE_PROMPT_CACHE_TTL=auto restores Claude Code automatic choice; 1h keeps the default', () => {
        expect(decidePromptCacheTtl({ HAPPY_CLAUDE_PROMPT_CACHE_TTL: 'auto' }, none)).toBe('opted-out')
        expect(decidePromptCacheTtl({ HAPPY_CLAUDE_PROMPT_CACHE_TTL: '1H' }, none)).toBe('default-1h')
    })

    it('does not read settings files once env already decided', () => {
        let reads = 0
        decidePromptCacheTtl({ CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, () => { reads++; return [] })
        expect(reads).toBe(0)
    })
})

describe('applyPromptCacheTtlDefault', () => {
    let root: string
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'vh-ttl-')) })
    afterEach(() => rmSync(root, { recursive: true, force: true }))

    it('fills CLAUDE_CODE_PROMPT_CACHE_TTL=1h only (subagents keep their own TTL)', () => {
        const env: Record<string, string | undefined> = { CLAUDE_CONFIG_DIR: join(root, 'cfg') }
        expect(applyPromptCacheTtlDefault(env, join(root, 'repo'))).toBe('default-1h')
        expect(env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h')
        expect(env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL).toBeUndefined()
    })

    it('reads user (CLAUDE_CONFIG_DIR) and project/local settings files', () => {
        const cfg = join(root, 'cfg'); mkdirSync(cfg)
        writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ promptCacheTtl: '5m' }))
        const env: Record<string, string | undefined> = { CLAUDE_CONFIG_DIR: cfg }
        expect(applyPromptCacheTtlDefault(env, undefined)).toBe('user-settings')
        expect(env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBeUndefined()

        const repo = join(root, 'repo'); mkdirSync(join(repo, '.claude'), { recursive: true })
        writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ env: { FORCE_PROMPT_CACHING_5M: '1' } }))
        const env2: Record<string, string | undefined> = { CLAUDE_CONFIG_DIR: join(root, 'empty') }
        expect(applyPromptCacheTtlDefault(env2, repo)).toBe('user-settings')
        expect(env2.CLAUDE_CODE_PROMPT_CACHE_TTL).toBeUndefined()
    })

    it('ignores unreadable or malformed settings', () => {
        const cfg = join(root, 'cfg'); mkdirSync(cfg)
        writeFileSync(join(cfg, 'settings.json'), '{not json')
        const env: Record<string, string | undefined> = { CLAUDE_CONFIG_DIR: cfg }
        expect(applyPromptCacheTtlDefault(env, undefined)).toBe('default-1h')
    })

    it('includes the platform managed-settings file', () => {
        expect(claudeSettingsPaths({ CLAUDE_CONFIG_DIR: '/c' }, '/r', 'linux')).toEqual([
            '/c/settings.json', '/r/.claude/settings.json', '/r/.claude/settings.local.json', '/etc/claude-code/managed-settings.json',
        ])
        expect(claudeSettingsPaths({ CLAUDE_CONFIG_DIR: '/c' }, undefined, 'darwin').at(-1)).toBe('/Library/Application Support/ClaudeCode/managed-settings.json')
    })
})
