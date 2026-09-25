import { describe, expect, it } from 'vitest'
import { formatEditConflictNotice, formatSessionPeerMessage, parsePeerMessage, sanitizeHeaderValue } from './peerMessage'

describe('session peer message format (B-497)', () => {
    it('round-trips a message with every field', () => {
        const text = formatSessionPeerMessage({
            id: 'm1', replyTo: 'm0',
            from: { sessionId: 'sess_a', title: 'Fix login', flavor: 'claude', cwd: '/repo/wt a' },
            body: 'I am changing auth.ts, what are you touching?\nSecond line',
        })
        expect(text.split('\n')[0]).toBe('[Very Happy session message m1 from "Fix login" sess_a; agent claude; cwd /repo/wt a; re m0]')
        expect(text).toContain('session_message(to: "sess_a")')
        expect(parsePeerMessage(text)).toEqual({
            kind: 'message', id: 'm1', replyTo: 'm0',
            from: { sessionId: 'sess_a', title: 'Fix login', flavor: 'claude', cwd: '/repo/wt a' },
            body: 'I am changing auth.ts, what are you touching?\nSecond line',
        })
    })

    it('tolerates a missing title / cwd / replyTo and strips the footer', () => {
        const text = formatSessionPeerMessage({ id: 'm2', from: { sessionId: 'sess_b' }, body: 'ping' })
        const parsed = parsePeerMessage(text)
        expect(parsed).toMatchObject({ kind: 'message', id: 'm2', from: { sessionId: 'sess_b' }, body: 'ping' })
        expect(parsed && 'replyTo' in parsed).toBe(false)
        expect((parsed as { from: { title?: string } }).from.title).toBeUndefined()
    })

    it('tells a CLI-sent message apart: nothing to reply to', () => {
        const text = formatSessionPeerMessage({ id: 'm9', from: { sessionId: 'cli', title: 'cli me@host', flavor: 'cli', cwd: '/x' }, body: 'do it' })
        expect(text).toContain('no session to reply to')
        expect(text).not.toContain('session_message(to:')
        expect(parsePeerMessage(text)).toMatchObject({ kind: 'message', id: 'm9', from: { sessionId: 'cli', flavor: 'cli' }, body: 'do it' })
    })

    it('sanitises header-breaking characters out of titles and paths', () => {
        expect(sanitizeHeaderValue('a "quoted"; title]\nnext')).toBe('a quoted title next')
        const text = formatSessionPeerMessage({ id: 'm3', from: { sessionId: 's', title: 'x"; agent evil' }, body: 'b' })
        expect(parsePeerMessage(text)).toMatchObject({ from: { title: 'x agent evil', flavor: undefined } })
    })

    it('round-trips an edit conflict notice, including the terminal-mirror advice', () => {
        const text = formatEditConflictNotice({
            id: 'c1', path: '/repo/src/a.ts', windowMs: 30 * 60_000, peerEditedAgoMs: 125_000,
            peer: { sessionId: 'sess_t', title: 'terminal', flavor: 'terminal-mirror', cwd: '/repo' },
        })
        expect(text.split('\n')[0]).toBe('[Very Happy edit conflict c1; file /repo/src/a.ts; peer "terminal" sess_t; agent terminal-mirror; cwd /repo; peer edited 2m ago]')
        expect(text).toContain('cannot be messaged')
        expect(parsePeerMessage(text)).toMatchObject({
            kind: 'conflict', id: 'c1', path: '/repo/src/a.ts', peerEditedAgoMs: 120_000,
            peer: { sessionId: 'sess_t', title: 'terminal', flavor: 'terminal-mirror', cwd: '/repo' },
        })
        const managed = formatEditConflictNotice({ id: 'c2', path: '/p', windowMs: 60_000, peerEditedAgoMs: 4_000, peer: { sessionId: 'sess_m', flavor: 'codex' } })
        expect(managed).toContain('session_message(to: "sess_m"')
        expect(managed).toContain('within the last 60s')
    })

    it('returns null for anything else', () => {
        expect(parsePeerMessage('hello')).toBeNull()
        expect(parsePeerMessage('[Very Happy team message x; task y; from Owner]\nbody')).toBeNull()
        expect(parsePeerMessage('[Very Happy session message m from "t" ]\nbody')).toBeNull()
    })
})
