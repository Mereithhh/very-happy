import { describe, expect, it } from 'vitest'
import {
    capRemoteTranscript,
    compareVersions,
    formatRemoteAuditLine,
    guardRemoteSessionOpsRequest,
    parseHappyClientVersion,
    RemoteCallBudget,
    REMOTE_TEXT_MAX_BYTES,
    supportsRemoteSessionOps,
} from './remoteSessionOps'

const from = { machineId: 'mac-A', host: 'mac', cli: '0.2.157' }

describe('guardRemoteSessionOpsRequest (B-506)', () => {
    it('refuses everything when the target machine turned the feature off — with a code, not a 15 s silence', () => {
        const out = guardRemoteSessionOpsRequest('sessions.read', { v: 1, from, args: { sessionId: 's1' } }, { enabled: false })
        expect(out).toEqual({ ok: false, error: { code: 'disabled', message: expect.stringContaining('remoteSessionOps') } })
    })

    it('rejects the wrong protocol version, a missing caller and non-object requests', () => {
        expect(guardRemoteSessionOpsRequest('sessions.list', { v: 2, from, args: {} }, { enabled: true })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
        expect(guardRemoteSessionOpsRequest('sessions.list', { v: 1, args: {} }, { enabled: true })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
        expect(guardRemoteSessionOpsRequest('sessions.list', 'nope', { enabled: true })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    })

    it('keeps only the known caller fields, bounded, and validates the optional session id', () => {
        const out = guardRemoteSessionOpsRequest('sessions.list', { v: 1, from: { ...from, sessionId: 'bad id', extra: 1, host: 'h'.repeat(300) }, args: {} }, { enabled: true })
        expect(out.ok && out.request.from).toEqual({ machineId: 'mac-A', host: 'h'.repeat(128), cli: '0.2.157' })
    })

    it('sessions.list: ids must be session ids, capped; all/tag/limit normalised', () => {
        expect(guardRemoteSessionOpsRequest('sessions.list', { v: 1, from, args: { ids: ['ok', 'bad id'] } }, { enabled: true })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
        expect(guardRemoteSessionOpsRequest('sessions.list', { v: 1, from, args: { ids: Array.from({ length: 201 }, (_, i) => `s${i}`) } }, { enabled: true })).toMatchObject({ ok: false, error: { code: 'too_large' } })
        const out = guardRemoteSessionOpsRequest('sessions.list', { v: 1, from, args: { ids: ['s1'], all: true, tag: 'bot', limit: 3.7 } }, { enabled: true })
        expect(out.ok && out.request.args).toEqual({ ids: ['s1'], all: true, tag: 'bot', limit: 3 })
    })

    it('sessions.read / send / message require a session id and bound the text', () => {
        expect(guardRemoteSessionOpsRequest('sessions.read', { v: 1, from, args: {} }, { enabled: true })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
        expect(guardRemoteSessionOpsRequest('sessions.send', { v: 1, from, args: { sessionId: 's1', text: '   ' } }, { enabled: true })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
        expect(guardRemoteSessionOpsRequest('sessions.send', { v: 1, from, args: { sessionId: 's1', text: 'x'.repeat(REMOTE_TEXT_MAX_BYTES + 1) } }, { enabled: true })).toMatchObject({ ok: false, error: { code: 'too_large' } })
        const send = guardRemoteSessionOpsRequest('sessions.send', { v: 1, from, args: { sessionId: 's1', text: 'hi', resume: true, model: null, sentFrom: 'assistant' } }, { enabled: true })
        expect(send.ok && send.request.args).toEqual({ sessionId: 's1', text: 'hi', resume: true, model: null, sentFrom: 'assistant' })
        expect(guardRemoteSessionOpsRequest('sessions.message', { v: 1, from, args: { to: 's1', body: 'x' } }, { enabled: true })).toMatchObject({ ok: false, error: { code: 'bad_request', message: expect.stringContaining('sender') } })
        const msg = guardRemoteSessionOpsRequest('sessions.message', { v: 1, from, args: { to: 's1', body: 'x', replyTo: 'm0', from: { sessionId: 'sA', title: 'T', flavor: 'claude', cwd: '/w', junk: 1 } } }, { enabled: true })
        // The sender's machine defaults to the caller's host so the recipient's header names it.
        expect(msg.ok && msg.request.args).toEqual({ to: 's1', body: 'x', replyTo: 'm0', from: { sessionId: 'sA', title: 'T', flavor: 'claude', cwd: '/w', machine: 'mac' } })
    })

    it('sessions.peers: scope whitelist, cwd optional', () => {
        expect(guardRemoteSessionOpsRequest('sessions.peers', { v: 1, from, args: { scope: 'planet' } }, { enabled: true })).toMatchObject({ ok: false, error: { code: 'bad_request' } })
        const out = guardRemoteSessionOpsRequest('sessions.peers', { v: 1, from, args: { scope: 'repo', cwd: '/home/u/repo' } }, { enabled: true })
        expect(out.ok && out.request.args).toEqual({ scope: 'repo', cwd: '/home/u/repo' })
    })
})

describe('RemoteCallBudget', () => {
    it('allows a burst of perMinute calls, then refuses with retryAfterMs, then refills with time', () => {
        let t = 0
        const budget = new RemoteCallBudget(3, () => t)
        expect(budget.take()).toEqual({ ok: true })
        expect(budget.take()).toEqual({ ok: true })
        expect(budget.take()).toEqual({ ok: true })
        const refused = budget.take()
        expect(refused.ok).toBe(false)
        expect(!refused.ok && refused.retryAfterMs).toBeGreaterThan(0)
        t += 20_001 // one token per 20 s at 3/min
        expect(budget.take()).toEqual({ ok: true })
        expect(budget.take().ok).toBe(false)
    })
})

describe('capRemoteTranscript / audit / versions', () => {
    it('keeps the tail and marks the cut when the transcript is over budget', () => {
        const long = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(50)}`).join('\n')
        const capped = capRemoteTranscript(long, 2_000)
        expect(capped.truncated).toBe(true)
        expect(Buffer.byteLength(capped.transcript)).toBeLessThanOrEqual(2_000)
        expect(capped.transcript.startsWith('… [truncated by the remote machine')).toBe(true)
        expect(capped.transcript.endsWith('line 199 ' + 'x'.repeat(50))).toBe(true)
        expect(capRemoteTranscript('short', 2_000)).toEqual({ transcript: 'short', truncated: false })
    })

    it('writes one audit line naming the claimed caller, the target and the outcome', () => {
        expect(formatRemoteAuditLine({ method: 'sessions.read', from: { ...from, sessionId: 'sA' }, sessionId: 's1', outcome: 'ok', durationMs: 12.6 }))
            .toBe('[REMOTE SESSION OPS] sessions.read from machine=mac-A host=mac cli=0.2.157 session=sA target=s1 → ok (13ms)')
        expect(formatRemoteAuditLine({ method: 'sessions.send', from: null, outcome: 'bad_request', durationMs: 0 }))
            .toBe('[REMOTE SESSION OPS] sessions.send from machine=? host=? cli=? session=- target=- → bad_request (0ms)')
    })

    it('parses the server\'s plaintext client tag and compares against the minimum', () => {
        expect(parseHappyClientVersion('cli-daemon/0.2.155')).toBe('0.2.155')
        expect(parseHappyClientVersion(null)).toBeNull()
        expect(compareVersions('0.2.157', '0.2.155')).toBeGreaterThan(0)
        expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
        expect(supportsRemoteSessionOps('0.2.155')).toBe(false)
        expect(supportsRemoteSessionOps('0.2.157')).toBe(true)
        expect(supportsRemoteSessionOps(null)).toBeNull()
    })
})
