import { describe, expect, it } from 'vitest'
import { parseSpawnArgs, sessionWebUrl } from './spawn'
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
