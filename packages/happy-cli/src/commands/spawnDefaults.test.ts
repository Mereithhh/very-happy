import { describe, expect, it } from 'vitest'
import { AGENT_CODE_DEFAULTS, CLAUDE_OPUS_55_CAPABILITY, LATEST_MODEL_MODE } from '@slopus/happy-wire'
import { resolveFirstMessageMeta, resolveSpawnPermissionMode, waitsForModelCatalog } from './spawnDefaults'

// Codex bundled `model/list` (probed 2026-10-30).
const CODEX_154 = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2'].map((code) => ({ code, value: code }))
const CODEX_166 = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-6.1-terra', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'].map((code) => ({ code, value: code }))

// B-492: `very-happy spawn` must start a session exactly like the web launcher.
describe('resolveSpawnPermissionMode', () => {
    it('defaults to the launcher code default per agent (claude/codex/pi yolo)', () => {
        expect(resolveSpawnPermissionMode(undefined, undefined)).toBe('bypassPermissions')
        expect(resolveSpawnPermissionMode('claude', undefined)).toBe(AGENT_CODE_DEFAULTS.claude.permissionMode)
        expect(resolveSpawnPermissionMode('codex', undefined)).toBe('yolo')
        expect(resolveSpawnPermissionMode('pi', undefined)).toBe('bypassPermissions')
        expect(resolveSpawnPermissionMode('gemini', undefined)).toBe('default')
    })

    it('keeps an explicit mode', () => {
        expect(resolveSpawnPermissionMode('claude', 'plan')).toBe('plan')
    })
})

describe('resolveFirstMessageMeta', () => {
    const capable = [CLAUDE_OPUS_55_CAPABILITY]

    it('claude: latest resolves to pinned Opus 5.5 with effort reset, like the web message meta', () => {
        expect(resolveFirstMessageMeta({ agent: 'claude', permissionMode: 'bypassPermissions', capabilities: capable }))
            .toEqual({ permissionMode: 'bypassPermissions', model: 'claude-opus-5-5', effort: null, modelIntent: 'latest', effortIntent: 'default' })
    })

    it('claude: falls back to the machine default when the wrapper can run no known Opus', () => {
        expect(resolveFirstMessageMeta({ agent: 'claude', permissionMode: 'bypassPermissions', capabilities: [] }).model).toBeNull()
        expect(resolveFirstMessageMeta({ agent: 'claude', permissionMode: 'bypassPermissions', capabilities: null }).model).toBeNull()
    })

    it('claude: follows a newer Opus from the server table only when the wrapper proves it', () => {
        const latestTable = {
            version: 2,
            agents: { claude: { tier: 'opus', pattern: '^claude-opus-(\\d+)(?:-(\\d{1,2}))?$', models: [
                { model: 'claude-opus-6', requires: { capability: 'claude-opus-6-v1' } },
                { model: 'claude-opus-5-5', requires: { capability: CLAUDE_OPUS_55_CAPABILITY } },
            ] } },
        }
        expect(resolveFirstMessageMeta({ agent: 'claude', permissionMode: 'default', capabilities: capable, latestTable }).model).toBe('claude-opus-5-5')
        expect(resolveFirstMessageMeta({ agent: 'claude', permissionMode: 'default', capabilities: ['claude-opus-6-v1'], latestTable }).model).toBe('claude-opus-6')
    })

    it('claude: spells yolo bypassPermissions on the wire', () => {
        expect(resolveFirstMessageMeta({ agent: undefined, permissionMode: 'yolo', capabilities: capable }).permissionMode).toBe('bypassPermissions')
    })

    it('an explicit --model wins, "default" means the machine default, "latest" resolves', () => {
        expect(resolveFirstMessageMeta({ agent: 'claude', permissionMode: 'default', explicitModel: 'claude-sonnet-5', capabilities: capable }).model).toBe('claude-sonnet-5')
        expect(resolveFirstMessageMeta({ agent: 'claude', permissionMode: 'default', explicitModel: 'default', capabilities: capable }).model).toBeNull()
        expect(resolveFirstMessageMeta({ agent: 'codex', permissionMode: 'yolo', explicitModel: 'gpt-6-sol' }).model).toBe('gpt-6-sol')
        expect(resolveFirstMessageMeta({ agent: 'codex', permissionMode: 'yolo', explicitModel: 'latest', catalog: CODEX_166, configuredModel: null }).model).toBe('gpt-6.1-sol')
        expect(resolveFirstMessageMeta({ agent: 'codex', permissionMode: 'yolo', explicitModel: 'latest' }).model).toBeNull()
    })

    it('codex: latest = newest sol the published catalog lists; no catalog → only the permission mode', () => {
        expect(resolveFirstMessageMeta({ agent: 'codex', permissionMode: 'yolo', catalog: CODEX_166, configuredModel: null })).toEqual({ permissionMode: 'yolo', model: 'gpt-6.1-sol', modelIntent: 'latest' })
        expect(resolveFirstMessageMeta({ agent: 'codex', permissionMode: 'yolo', catalog: CODEX_154, configuredModel: null })).toEqual({ permissionMode: 'yolo', model: 'gpt-5.6-sol', modelIntent: 'latest' })
        expect(resolveFirstMessageMeta({ agent: 'codex', permissionMode: 'yolo', configuredModel: null })).toEqual({ permissionMode: 'yolo', modelIntent: 'latest' })
    })

    it('codex: a model pinned in the machine config (or an unknown config) is never overridden', () => {
        expect(resolveFirstMessageMeta({ agent: 'codex', permissionMode: 'yolo', catalog: CODEX_166, configuredModel: 'gpt-5.6-sol' })).toEqual({ permissionMode: 'yolo', modelIntent: 'latest' })
        expect(resolveFirstMessageMeta({ agent: 'codex', permissionMode: 'yolo', catalog: CODEX_166 })).toEqual({ permissionMode: 'yolo', modelIntent: 'latest' })
        // An explicit --model still wins over the machine config.
        expect(resolveFirstMessageMeta({ agent: 'codex', permissionMode: 'yolo', explicitModel: 'gpt-6-sol', configuredModel: 'gpt-5.6-sol' }).model).toBe('gpt-6-sol')
    })

    it('never sends the sentinel itself', () => {
        for (const agent of ['claude', 'codex', 'gemini', 'pi', 'openclaw']) {
            for (const capabilities of [null, capable]) {
                expect(resolveFirstMessageMeta({ agent, permissionMode: 'default', capabilities }).model).not.toBe(LATEST_MODEL_MODE)
            }
        }
    })

    it('only codex/gemini following latest wait for the model catalog', () => {
        expect(waitsForModelCatalog('codex', undefined)).toBe(true)
        expect(waitsForModelCatalog('gemini', 'latest')).toBe(true)
        expect(waitsForModelCatalog('codex', 'gpt-5.5')).toBe(false)
        expect(waitsForModelCatalog('claude', undefined)).toBe(false)
        expect(waitsForModelCatalog('pi', undefined)).toBe(false)
    })
})

describe('first-message intent (B-849b2, QA28 P2-5)', () => {
    const capable = ['claude-opus-5-5-v1']
    it('a spawn without --model records latest, not the model it resolved to', () => {
        const claude = resolveFirstMessageMeta({ agent: 'claude', permissionMode: 'bypassPermissions', capabilities: capable })
        expect(claude.model).toBe('claude-opus-5-5')
        expect(claude.modelIntent).toBe('latest')
        expect(claude.effortIntent).toBe('default')
        const codex = resolveFirstMessageMeta({ agent: 'codex', permissionMode: 'yolo' })
        expect(codex.model).toBeUndefined()
        expect(codex.modelIntent).toBe('latest')
        expect(codex.effortIntent).toBeUndefined()
    })
    it('an explicit --model records the choice itself', () => {
        expect(resolveFirstMessageMeta({ agent: 'claude', permissionMode: 'default', explicitModel: 'latest', capabilities: capable }).modelIntent).toBe('latest')
        expect(resolveFirstMessageMeta({ agent: 'claude', permissionMode: 'default', explicitModel: 'default', capabilities: capable })).toMatchObject({ model: null, modelIntent: 'default' })
        expect(resolveFirstMessageMeta({ agent: 'codex', permissionMode: 'yolo', explicitModel: 'gpt-6-sol' })).toMatchObject({ model: 'gpt-6-sol', modelIntent: 'gpt-6-sol' })
    })
})

