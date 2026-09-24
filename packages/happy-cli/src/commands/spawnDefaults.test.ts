import { describe, expect, it } from 'vitest'
import { AGENT_CODE_DEFAULTS, CLAUDE_OPUS_55_CAPABILITY } from '@slopus/happy-wire'
import { resolveFirstMessageMeta, resolveSpawnPermissionMode } from './spawnDefaults'

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

    it('claude: pins Opus 5.5 with effort reset, like the web message meta', () => {
        expect(resolveFirstMessageMeta({ agent: 'claude', permissionMode: 'bypassPermissions', capabilities: capable }))
            .toEqual({ permissionMode: 'bypassPermissions', model: 'claude-opus-5-5', effort: null })
    })

    it('claude: falls back to the machine default when the wrapper cannot run Opus 5.5', () => {
        expect(resolveFirstMessageMeta({ agent: 'claude', permissionMode: 'bypassPermissions', capabilities: [] }).model).toBeNull()
        expect(resolveFirstMessageMeta({ agent: 'claude', permissionMode: 'bypassPermissions', capabilities: null }).model).toBeNull()
    })

    it('claude: spells yolo bypassPermissions on the wire', () => {
        expect(resolveFirstMessageMeta({ agent: undefined, permissionMode: 'yolo', capabilities: capable }).permissionMode).toBe('bypassPermissions')
    })

    it('an explicit --model wins, and "default" means the machine default', () => {
        expect(resolveFirstMessageMeta({ agent: 'claude', permissionMode: 'default', explicitModel: 'claude-sonnet-5', capabilities: capable }).model).toBe('claude-sonnet-5')
        expect(resolveFirstMessageMeta({ agent: 'claude', permissionMode: 'default', explicitModel: 'default', capabilities: capable }).model).toBeNull()
        expect(resolveFirstMessageMeta({ agent: 'codex', permissionMode: 'yolo', explicitModel: 'gpt-6-sol' }).model).toBe('gpt-6-sol')
    })

    it('non-claude agents carry only the permission mode unless --model is given', () => {
        expect(resolveFirstMessageMeta({ agent: 'codex', permissionMode: 'yolo' })).toEqual({ permissionMode: 'yolo' })
    })
})
