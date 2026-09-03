import { describe, expect, it } from 'vitest'
import { parseSessionsArgs } from './sessions'

const ID = 'cmtl3c0x7001vqr29o8nmclno'

describe('parseSessionsArgs (B-304)', () => {
    it('defaults to help with no arguments', () => {
        expect(parseSessionsArgs([]).action).toBe('help')
        expect(parseSessionsArgs(['--help']).action).toBe('help')
        expect(parseSessionsArgs(['-h']).action).toBe('help')
    })

    it('parses list with its options', () => {
        const options = parseSessionsArgs(['list', '--tag', 'tanka', '--limit', '5', '--json'])
        expect(options).toMatchObject({ action: 'list', tag: 'tanka', limit: 5, json: true })
    })

    it('parses the per-session actions with an id', () => {
        for (const action of ['read', 'stop', 'archive'] as const) {
            expect(parseSessionsArgs([action, ID])).toMatchObject({ action, sessionId: ID })
        }
    })

    it('rejects a per-session action without an id', () => {
        expect(() => parseSessionsArgs(['read'])).toThrow(/requires a session id/)
        expect(() => parseSessionsArgs(['stop'])).toThrow(/requires a session id/)
    })

    it('rejects a malformed session id before any network call', () => {
        expect(() => parseSessionsArgs(['read', '../etc/passwd'])).toThrow(/Invalid session id/)
        // An empty positional is present-but-unusable, so it fails validation
        // rather than the "you forgot the id" branch.
        expect(() => parseSessionsArgs(['archive', ''])).toThrow(/Invalid session id/)
    })

    it('rejects an unknown action and unknown flags', () => {
        expect(() => parseSessionsArgs(['destroy', ID])).toThrow(/Unknown action/)
        expect(() => parseSessionsArgs(['list', '--everything'])).toThrow(/Unknown argument/)
    })

    it('rejects a stray extra positional', () => {
        expect(() => parseSessionsArgs(['read', ID, ID])).toThrow(/Unexpected extra argument/)
        expect(() => parseSessionsArgs(['list', ID])).toThrow(/Unexpected argument/)
    })

    it('rejects --tag outside list, where it would silently do nothing', () => {
        expect(() => parseSessionsArgs(['read', ID, '--tag', 'tanka'])).toThrow(/only applies to/)
    })

    it('rejects a --limit that is not a positive integer', () => {
        expect(() => parseSessionsArgs(['list', '--limit', '0'])).toThrow(/positive integer/)
        expect(() => parseSessionsArgs(['list', '--limit', '-1'])).toThrow(/positive integer/)
        expect(() => parseSessionsArgs(['list', '--limit', 'many'])).toThrow(/positive integer/)
        expect(() => parseSessionsArgs(['list', '--limit'])).toThrow(/requires a value/)
    })

    it('--help anywhere wins over a partially parsed command', () => {
        expect(parseSessionsArgs(['read', ID, '--help']).action).toBe('help')
    })
})
