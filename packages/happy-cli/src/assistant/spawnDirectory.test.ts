/**
 * Unit tests for session_spawn directory validation (B-051 review fix C4):
 * "~" expansion + absolute-path enforcement before anything reaches the
 * daemon (which would otherwise mkdir -p a relative path under its cwd).
 */

import { describe, expect, it } from 'vitest'
import { normalizeSpawnDirectory } from './spawnDirectory'

const HOME = '/Users/tester'

describe('normalizeSpawnDirectory', () => {
    it('passes absolute paths through (normalized)', () => {
        expect(normalizeSpawnDirectory('/repos/app', HOME)).toEqual({ ok: true, directory: '/repos/app' })
        expect(normalizeSpawnDirectory('/repos/app/../lib', HOME)).toEqual({ ok: true, directory: '/repos/lib' })
        expect(normalizeSpawnDirectory('  /repos/app  ', HOME)).toEqual({ ok: true, directory: '/repos/app' })
    })

    it('expands a leading ~ to the home directory', () => {
        expect(normalizeSpawnDirectory('~', HOME)).toEqual({ ok: true, directory: HOME })
        expect(normalizeSpawnDirectory('~/code/app', HOME)).toEqual({ ok: true, directory: `${HOME}/code/app` })
    })

    it('rejects relative paths instead of forwarding them to the daemon', () => {
        for (const bad of ['code/app', './code', '../up', '.']) {
            const result = normalizeSpawnDirectory(bad, HOME)
            expect(result.ok).toBe(false)
            if (!result.ok) expect(result.error).toContain('absolute')
        }
    })

    it('rejects ~user paths (unsupported expansion)', () => {
        const result = normalizeSpawnDirectory('~bob/code', HOME)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error).toContain('~user')
    })

    it('rejects empty and whitespace-only input', () => {
        expect(normalizeSpawnDirectory('', HOME).ok).toBe(false)
        expect(normalizeSpawnDirectory('   ', HOME).ok).toBe(false)
    })
})
