import { describe, expect, it } from 'vitest'
import { parseEnvAssignment, parseSpawnArgs, sessionWebUrl } from './spawn'
import { configuration } from '@/configuration'

describe('parseSpawnArgs', () => {
    it('parses --dir with a prompt', () => {
        const options = parseSpawnArgs(['--dir', '/tmp/foo', '--prompt', 'hello'])
        expect(options.dir).toBe('/tmp/foo')
        expect(options.prompt).toBe('hello')
        expect(options.promptFile).toBeUndefined()
        expect(options.json).toBe(false)
        expect(options.help).toBe(false)
    })

    it('parses short aliases and --json', () => {
        const options = parseSpawnArgs(['-d', '/tmp/foo', '-p', 'hi', '--json'])
        expect(options.dir).toBe('/tmp/foo')
        expect(options.prompt).toBe('hi')
        expect(options.json).toBe(true)
    })

    it('parses --prompt-file', () => {
        const options = parseSpawnArgs(['--dir', '/tmp/foo', '--prompt-file', '/tmp/p.txt'])
        expect(options.promptFile).toBe('/tmp/p.txt')
        expect(options.prompt).toBeUndefined()
    })

    it('allows spawn without any prompt (spawn-only mode)', () => {
        const options = parseSpawnArgs(['--dir', '/tmp/foo'])
        expect(options.prompt).toBeUndefined()
        expect(options.promptFile).toBeUndefined()
    })

    it('parses --help', () => {
        expect(parseSpawnArgs(['--help']).help).toBe(true)
        expect(parseSpawnArgs(['-h']).help).toBe(true)
    })

    it('parses --spawned-by (B-303 origin tag)', () => {
        const options = parseSpawnArgs(['--dir', '/tmp/foo', '--spawned-by', 'tanka'])
        expect(options.spawnedBy).toBe('tanka')
    })

    it('omits spawnedBy when the flag is absent (untagged session)', () => {
        expect(parseSpawnArgs(['--dir', '/tmp/foo']).spawnedBy).toBeUndefined()
    })

    it('rejects a --spawned-by value that would not render as a tag chip', () => {
        // Fail here rather than at the daemon: an unattended adapter would
        // otherwise get a healthy but silently untagged session.
        expect(() => parseSpawnArgs(['--dir', '/tmp', '--spawned-by', 'Tanka'])).toThrow(/--spawned-by/)
        expect(() => parseSpawnArgs(['--dir', '/tmp', '--spawned-by', 'two words'])).toThrow(/--spawned-by/)
        expect(() => parseSpawnArgs(['--dir', '/tmp', '--spawned-by', 'x'.repeat(25)])).toThrow(/--spawned-by/)
    })

    it('rejects --spawned-by without a value', () => {
        expect(() => parseSpawnArgs(['--dir', '/tmp', '--spawned-by'])).toThrow(/requires a value/)
    })

    it('parses --permission-mode (B-306)', () => {
        expect(parseSpawnArgs(['--dir', '/tmp', '--permission-mode', 'bypassPermissions']).permissionMode)
            .toBe('bypassPermissions')
        expect(parseSpawnArgs(['--dir', '/tmp', '--permission-mode', 'plan']).permissionMode).toBe('plan')
    })

    it('rejects a permission mode the daemon would silently drop', () => {
        // The daemon logs an invalid mode and spawns WITHOUT the flag, so a typo
        // would hand an unattended dispatcher a session that blocks on approval.
        expect(() => parseSpawnArgs(['--dir', '/tmp', '--permission-mode', 'yolo-please'])).toThrow(/--permission-mode/)
        expect(() => parseSpawnArgs(['--dir', '/tmp', '--permission-mode', 'read-only'])).toThrow(/--permission-mode/)
        expect(() => parseSpawnArgs(['--dir', '/tmp', '--permission-mode'])).toThrow(/requires a value/)
    })

    it('omits permissionMode when the flag is absent (daemon default applies)', () => {
        expect(parseSpawnArgs(['--dir', '/tmp']).permissionMode).toBeUndefined()
    })

    it('parses --agent and rejects an unsupported backend', () => {
        expect(parseSpawnArgs(['--dir', '/tmp', '--agent', 'codex']).agent).toBe('codex')
        expect(() => parseSpawnArgs(['--dir', '/tmp', '--agent', 'gpt'])).toThrow(/--agent must be one of/)
    })

    it('collects repeated --env pairs', () => {
        const options = parseSpawnArgs(['--dir', '/tmp', '--env', 'A=1', '--env', 'B=two=three'])
        expect(options.env).toEqual({ A: '1', B: 'two=three' })
    })

    it('rejects a malformed --env pair', () => {
        expect(() => parseSpawnArgs(['--dir', '/tmp', '--env', 'NOPE'])).toThrow(/KEY=VALUE/)
        expect(() => parseSpawnArgs(['--dir', '/tmp', '--env', '=1'])).toThrow(/KEY=VALUE/)
        expect(() => parseSpawnArgs(['--dir', '/tmp', '--env', '1BAD=x'])).toThrow(/valid variable name/)
        expect(() => parseSpawnArgs(['--dir', '/tmp', '--env'])).toThrow(/requires a value/)
    })

    it('parseEnvAssignment keeps everything after the first = as the value', () => {
        expect(parseEnvAssignment('K=a=b=c')).toEqual(['K', 'a=b=c'])
        expect(parseEnvAssignment('K=')).toEqual(['K', ''])
    })

    it('rejects --prompt together with --prompt-file', () => {
        expect(() => parseSpawnArgs(['--dir', '/tmp', '--prompt', 'x', '--prompt-file', '/tmp/p.txt']))
            .toThrow(/mutually exclusive/)
    })

    it('rejects flags missing their value', () => {
        expect(() => parseSpawnArgs(['--dir'])).toThrow(/--dir requires a value/)
        expect(() => parseSpawnArgs(['--dir', '/tmp', '--prompt'])).toThrow(/--prompt requires a value/)
        expect(() => parseSpawnArgs(['--dir', '/tmp', '--prompt-file'])).toThrow(/--prompt-file requires a value/)
    })

    it('rejects unknown arguments', () => {
        expect(() => parseSpawnArgs(['--dir', '/tmp', '--frobnicate'])).toThrow(/Unknown argument: --frobnicate/)
    })
})

describe('sessionWebUrl', () => {
    it('builds the session URL from the configured webapp URL', () => {
        expect(sessionWebUrl('abc123')).toBe(`${configuration.webappUrl.replace(/\/+$/, '')}/session/abc123`)
        expect(sessionWebUrl('abc123')).toMatch(/\/session\/abc123$/)
        // No double slash between host and path
        expect(sessionWebUrl('abc123')).not.toMatch(/[^:]\/\/session/)
    })
})
