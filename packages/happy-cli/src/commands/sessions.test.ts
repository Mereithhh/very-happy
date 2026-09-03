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

const REQ = 'toolu_01AbC-def.9:x'

describe('parseSessionsArgs — list --all, approve, deny (supervisor lane B)', () => {
    it('parses list --all with its own options and keeps the legacy defaults off', () => {
        const legacy = parseSessionsArgs(['list'])
        expect(legacy).toMatchObject({ action: 'list', all: false, includeArchived: false })
        const all = parseSessionsArgs(['list', '--all', '--include-archived', '--tag', 'supervisor', '--json'])
        expect(all).toMatchObject({ action: 'list', all: true, includeArchived: true, tag: 'supervisor', json: true })
    })

    it('rejects --all and --include-archived where they would silently do nothing', () => {
        expect(() => parseSessionsArgs(['read', ID, '--all'])).toThrow(/--all only applies/)
        expect(() => parseSessionsArgs(['list', '--include-archived'])).toThrow(/--include-archived only applies to `sessions list --all`/)
        expect(() => parseSessionsArgs(['stop', ID, '--include-archived'])).toThrow(/--include-archived only applies/)
    })

    it('parses approve / deny with a session id and a request id', () => {
        expect(parseSessionsArgs(['approve', ID, REQ])).toMatchObject({ action: 'approve', sessionId: ID, requestId: REQ, forSession: false })
        expect(parseSessionsArgs(['approve', ID, REQ, '--for-session', '--json'])).toMatchObject({ forSession: true, json: true })
        expect(parseSessionsArgs(['deny', ID, REQ, '--reason', 'not in scope'])).toMatchObject({ action: 'deny', reason: 'not in scope' })
    })

    it('rejects approve / deny without both ids, and a malformed request id before any network call', () => {
        expect(() => parseSessionsArgs(['approve', ID])).toThrow(/requires a session id and a request id/)
        expect(() => parseSessionsArgs(['deny'])).toThrow(/requires a session id/)
        expect(() => parseSessionsArgs(['approve', ID, 'has space'])).toThrow(/Invalid request id/)
        expect(() => parseSessionsArgs(['approve', ID, ''])).toThrow(/Invalid request id/)
        expect(() => parseSessionsArgs(['approve', '../x', REQ])).toThrow(/Invalid session id/)
    })

    it('still rejects a stray third positional and a second positional on one-id actions', () => {
        expect(() => parseSessionsArgs(['approve', ID, REQ, 'extra'])).toThrow(/Unexpected extra argument: extra/)
        expect(() => parseSessionsArgs(['read', ID, REQ])).toThrow(/Unexpected extra argument/)
    })

    it('rejects --for-session outside approve and --reason outside deny', () => {
        expect(() => parseSessionsArgs(['deny', ID, REQ, '--for-session'])).toThrow(/--for-session only applies/)
        expect(() => parseSessionsArgs(['approve', ID, REQ, '--reason', 'x'])).toThrow(/--reason only applies/)
        expect(() => parseSessionsArgs(['deny', ID, REQ, '--reason'])).toThrow(/--reason requires a value/)
    })

    it('lists approve and deny in the unknown-action hint', () => {
        expect(() => parseSessionsArgs(['allow', ID, REQ])).toThrow(/expected list, read, stop, archive, approve, deny/)
    })
})
