import { describe, expect, it } from 'vitest'
import { AttentionItemPostSchema, parseWrapupPayload } from '@slopus/happy-wire'
import {
    buildHandoffPost, buildRunningPost, buildWrapupReportPost, formatHandoffBody, shouldArchiveAfterHandoff, wrapupTitle,
    HandoffSendInputSchema, SessionHandoffInputSchema, SessionWrapupInputSchema, WrapupReportInputSchema,
} from './report'

const report = WrapupReportInputSchema.parse({
    summary: 'Fixed the login redirect\nand added a test',
    files: ['src/a.ts', 'src/b.ts'],
    commits: [{ sha: 'a1b2c3d', subject: 'fix redirect', repo: 'acme/web' }],
    pending: ['Ship to prod?', 'Update docs?'],
    can_close: false,
})

describe('B-915 wrap-up posts', () => {
    it('validates tool input against the wire limits', () => {
        expect(WrapupReportInputSchema.safeParse({ summary: 'x', can_close: true }).success).toBe(true)
        expect(WrapupReportInputSchema.safeParse({ summary: '', can_close: true }).success).toBe(false)
        expect(WrapupReportInputSchema.safeParse({ summary: 'x', can_close: true, commits: [{ sha: 'nothex!' }] }).success).toBe(false)
        expect(WrapupReportInputSchema.safeParse({ summary: 'x', can_close: true, pending: Array.from({ length: 11 }, (_, i) => `p${i}`) }).success).toBe(false)
        expect(WrapupReportInputSchema.safeParse({ summary: 'x' }).success).toBe(false)
        expect(SessionWrapupInputSchema.safeParse({ session_ids: [] }).success).toBe(false)
        expect(SessionWrapupInputSchema.safeParse({ session_ids: Array.from({ length: 21 }, (_, i) => `s${i}`) }).success).toBe(false)
        expect(SessionWrapupInputSchema.safeParse({ session_ids: ['s1'], template: 'mine', request_id: 'r1' }).success).toBe(true)
        expect(HandoffSendInputSchema.safeParse({ to: 's2', summary: 'state' }).success).toBe(true)
        expect(SessionHandoffInputSchema.safeParse({ from: 's1', to: 's2', archive_after: true, request_id: 'r' }).success).toBe(true)
    })

    it('a report becomes a done wrapup card the server accepts, linked to the running turn', () => {
        const post = buildWrapupReportPost('s1', report, { mode: 'wrapup', localId: 'wrapup-n1', startedAt: 100 }, 500, 'req-1')
        expect(AttentionItemPostSchema.safeParse(post).success).toBe(true)
        expect(post).toMatchObject({ sessionId: 's1', source: 'agent', kind: 'wrapup', key: 'wrapup', title: 'Fixed the login redirect', anchor: { localId: 'wrapup-n1' }, requestId: 'req-1' })
        expect(parseWrapupPayload(post.payload)).toMatchObject({
            v: 1, mode: 'wrapup', status: 'done', localId: 'wrapup-n1', startedAt: 100, canClose: false,
            files: ['src/a.ts', 'src/b.ts'], commits: [{ sha: 'a1b2c3d' }],
            pending: [{ id: 'p1', label: 'Ship to prod?', checked: false }, { id: 'p2', label: 'Update docs?', checked: false }],
        })
    })

    it('a report without a running turn (or from the other mode) starts now and has no anchor', () => {
        const post = buildWrapupReportPost('s1', { summary: 'x', can_close: true }, { mode: 'handoff', localId: 'handoff-1', startedAt: 1 }, 500, 'r')
        expect(post.anchor).toBeUndefined()
        expect(post.payload).toMatchObject({ startedAt: 500 })
        expect(post.payload).not.toHaveProperty('localId')
        expect(post.payload).not.toHaveProperty('pending')
        expect(AttentionItemPostSchema.safeParse(post).success).toBe(true)
    })

    it('the running card is idempotent per turn and valid', () => {
        const post = buildRunningPost('s1', { mode: 'handoff', localId: 'handoff-abc', startedAt: 7 })
        expect(AttentionItemPostSchema.safeParse(post).success).toBe(true)
        expect(post).toMatchObject({ key: 'handoff', requestId: 'running-handoff-abc', payload: { status: 'running', mode: 'handoff', startedAt: 7 } })
    })

    it('handoff cards: delivered / failed (red) / archived', () => {
        const base = { to: 's2', toTitle: 'Target', summary: 'state', artifacts: ['docs/x.md'], archiveAfter: true }
        const ok = buildHandoffPost('s1', { ...base, delivery: 'delivered', machine: 'mac' }, null, 9, 'r1')
        expect(AttentionItemPostSchema.safeParse(ok).success).toBe(true)
        expect(ok).toMatchObject({ key: 'handoff', title: 'Handed off to Target', payload: { mode: 'handoff', status: 'done', handoff: { to: 's2', delivery: 'delivered', machine: 'mac', archiveAfter: true } } })
        const failed = buildHandoffPost('s1', { ...base, delivery: 'failed', error: 'not running' }, null, 9, 'r2')
        expect(failed).toMatchObject({ title: 'Handoff to Target failed', payload: { status: 'failed', handoff: { delivery: 'failed', error: 'not running' } } })
        const archived = buildHandoffPost('s1', { ...base, delivery: 'delivered', archived: true }, null, 9, 'r3')
        expect(archived.payload).toMatchObject({ handoff: { archived: true } })
        expect(AttentionItemPostSchema.safeParse(archived).success).toBe(true)
    })

    it('archives only after a confirmed delivery that was asked for', () => {
        expect(shouldArchiveAfterHandoff({ archiveAfter: true, delivery: 'delivered' })).toBe(true)
        expect(shouldArchiveAfterHandoff({ archiveAfter: true, delivery: 'offline-stored' })).toBe(false)
        expect(shouldArchiveAfterHandoff({ archiveAfter: true, delivery: 'failed' })).toBe(false)
        expect(shouldArchiveAfterHandoff({ archiveAfter: false, delivery: 'delivered' })).toBe(false)
    })

    it('title and body helpers', () => {
        expect(wrapupTitle('\n\n  first line  \nsecond')).toBe('first line')
        expect(wrapupTitle('x'.repeat(300))).toHaveLength(120)
        expect(formatHandoffBody(' state ', ['a', 'b'])).toBe('state\n\nArtifacts:\n- a\n- b')
        expect(formatHandoffBody('state', [])).toBe('state')
    })
})
