import { describe, expect, it } from 'vitest'
import { frameVerdict, parseAttentionArgs } from './panels'

describe('B-510 panels check: frame headers', () => {
    it('X-Frame-Options DENY / SAMEORIGIN forbid embedding', () => {
        expect(frameVerdict({ 'x-frame-options': 'deny' })).toEqual({ embeddable: false, reason: 'X-Frame-Options: DENY' })
        expect(frameVerdict({ 'x-frame-options': 'SAMEORIGIN' }).embeddable).toBe(false)
    })
    it('CSP frame-ancestors without * or veryhappy.dev forbids; with them allows', () => {
        expect(frameVerdict({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" }).embeddable).toBe(false)
        expect(frameVerdict({ 'content-security-policy': 'frame-ancestors https://veryhappy.dev' }).embeddable).toBe(true)
        expect(frameVerdict({ 'content-security-policy': 'frame-ancestors *' }).embeddable).toBe(true)
        expect(frameVerdict({}).embeddable).toBe(true)
    })
})

describe('B-510 attention args', () => {
    it('joins the reason words and reads --panel / --session', () => {
        expect(parseAttentionArgs(['scan', 'the', 'QR', '--panel', 'desktop'])).toEqual({ reason: 'scan the QR', panel: 'desktop' })
        expect(parseAttentionArgs(['--session', 's1', '2FA'])).toEqual({ reason: '2FA', session: 's1' })
    })
    it('rejects an empty reason, unknown options and a missing value', () => {
        expect(parseAttentionArgs([])).toHaveProperty('error')
        expect(parseAttentionArgs(['x', '--loud'])).toHaveProperty('error')
        expect(parseAttentionArgs(['x', '--panel'])).toHaveProperty('error')
    })
})
