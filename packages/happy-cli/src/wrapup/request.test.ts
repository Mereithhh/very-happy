import { describe, expect, it, vi } from 'vitest'
import { encodeWrapupConfig, WRAPUP_PROTOCOL_TAIL, decodeWrapupConfig } from '@slopus/happy-wire'
import type { DeliveryResult } from '@/commands/sessionDelivery'
import { builtinNonce, requestHandoff, requestWrapup, WRAPUP_UPGRADE_HINT, wrapupUpgradeNeeded, type BuiltinRequestDeps } from './request'

const live = (sessionId: string): DeliveryResult => ({ sessionId, status: 'live', delivered: true, resumed: false, stored: true })
const running = (mode: string, startedAt: number) => ({ kind: 'wrapup', key: mode, state: 'open', updatedAt: startedAt, payload: { v: 1, mode, status: 'running', startedAt } })

function deps(over: Partial<BuiltinRequestDeps> = {}) {
    const sent: Array<{ via: string; sessionId: string; text: string; localId: string; displayText: string; resume: boolean }> = []
    const d: Partial<BuiltinRequestDeps> = {
        openItems: async () => [],
        readConfig: async () => decodeWrapupConfig(encodeWrapupConfig({ template: 'My template', lang: 'zh' })),
        readPersisted: () => ({ local1: { encryptionKey: 'k' } as never }),
        readState: async () => ({ found: true, archivedAt: null }),
        deliverLocal: async (sessionId, _p, text, o) => { sent.push({ via: 'local', sessionId, text, ...o }); return live(sessionId) },
        deliverRemote: async (sessionId, text, o) => { sent.push({ via: 'remote', sessionId, text, ...o }); return live(sessionId) },
        now: () => 10_000,
        nonce: () => 'rnd',
        localIdExists: async () => false,
        ...over,
    }
    return { d, sent }
}

describe('B-915 session_wrapup / sessions wrapup', () => {
    it('sends one turn per session (local key here, else the owning machine) with the template, a wrapup- localId and the chip label', async () => {
        const { d, sent } = deps()
        const results = await requestWrapup(['local1', 'remote1', 'local1'], {}, d)
        expect(results).toEqual([{ sessionId: 'local1', state: 'queued' }, { sessionId: 'remote1', state: 'queued' }])
        expect(sent.map((s) => [s.via, s.sessionId, s.localId, s.displayText])).toEqual([['local', 'local1', 'wrapup-rnd', '收尾'], ['remote', 'remote1', 'wrapup-rnd', '收尾']])
        expect(sent[0].text).toBe(`My template\n\n${WRAPUP_PROTOCOL_TAIL}`)
    })

    it('is idempotent: a fresh running card answers running and sends nothing; a stale one is retried', async () => {
        const { d, sent } = deps({ openItems: async (id) => id === 'local1' ? [running('wrapup', 9_000)] : [running('wrapup', 10_000 - 3 * 60 * 60 * 1000)] })
        const results = await requestWrapup(['local1', 'remote1'], {}, d)
        expect(results).toEqual([{ sessionId: 'local1', state: 'running' }, { sessionId: 'remote1', state: 'queued' }])
        expect(sent.map((s) => s.sessionId)).toEqual(['remote1'])
    })

    it('a running handoff does not block a wrap-up', async () => {
        const { d } = deps({ openItems: async () => [running('handoff', 9_500)] })
        expect(await requestWrapup(['local1'], {}, d)).toEqual([{ sessionId: 'local1', state: 'queued' }])
    })

    it('template override, request id → stable localIds, self and bad ids refused', async () => {
        const { d, sent } = deps()
        const results = await requestWrapup(['self1', 'bad id', 'local1'], { template: 'Override', requestId: 'req-1', self: 'self1' }, d)
        expect(results.map((r) => r.state)).toEqual(['error', 'error', 'queued'])
        expect(sent[0].text.startsWith('Override\n\n')).toBe(true)
        expect(sent[0].localId).toBe(`wrapup-${builtinNonce('req-1', 'wrapup', 'local1', () => 'x')}`)
        expect(builtinNonce('req-1', 'wrapup', 'local1', () => 'x')).toBe(builtinNonce('req-1', 'wrapup', 'local1', () => 'y'))
        expect(builtinNonce('req-1', 'wrapup', 'local1', () => 'x')).not.toBe(builtinNonce('req-1', 'handoff', 'local1', () => 'x'))
    })

    it('B-919: a retried request id whose localId is already in the session sends nothing and says deduped (state from its card)', async () => {
        const localId = `wrapup-${builtinNonce('req-9', 'wrapup', 'local1', () => 'x')}`
        const seen: string[] = []
        const card = (status: string) => ({ kind: 'wrapup', key: 'wrapup', state: 'open', updatedAt: 9_000, payload: { v: 1, mode: 'wrapup', status, localId, startedAt: 9_000 } })
        for (const [items, state] of [[[], 'queued'], [[card('running')], 'running'], [[card('done')], 'done']] as const) {
            const { d, sent } = deps({ localIdExists: async (_s, id) => { seen.push(id); return true }, openItems: async () => items as never })
            expect(await requestWrapup(['local1'], { requestId: 'req-9' }, d)).toEqual([{ sessionId: 'local1', state, deduped: true }])
            expect(sent).toEqual([])
        }
        expect(new Set(seen)).toEqual(new Set([localId]))
        // Without a request id the nonce is random: nothing to look up.
        const lookup = vi.fn(async () => true)
        const { d, sent } = deps({ localIdExists: lookup })
        expect(await requestWrapup(['local1'], {}, d)).toEqual([{ sessionId: 'local1', state: 'queued' }])
        expect(lookup).not.toHaveBeenCalled()
        expect(sent).toHaveLength(1)
        // Handoff to an existing session: same rule.
        const h = deps({ localIdExists: async () => true })
        expect(await requestHandoff({ from: 'local1', to: 'local2', requestId: 'req-9' }, h.d)).toEqual({ sessionId: 'local1', state: 'queued', deduped: true })
        expect(h.sent).toEqual([])
    })

    it('a session that is not live is an error receipt, never a throw', async () => {
        const { d } = deps({
            deliverLocal: async (sessionId) => ({ sessionId, status: 'offline', delivered: false, resumed: false, stored: false, error: 'offline' }),
            deliverRemote: async () => { throw new Error('not located') },
        })
        expect(await requestWrapup(['local1', 'remote1'], {}, d)).toEqual([
            { sessionId: 'local1', state: 'error', error: 'offline' },
            { sessionId: 'remote1', state: 'error', error: 'not located' },
        ])
    })
})

describe('B-915 session_handoff / sessions handoff', () => {
    it('asks the source with the handoff prompt naming the target and the archive choice', async () => {
        const { d, sent } = deps()
        const result = await requestHandoff({ from: 'local1', to: 'target1', toTitle: 'Target', machineId: 'm2', archiveAfter: true, note: 'be brief' }, d)
        expect(result).toEqual({ sessionId: 'local1', state: 'queued' })
        expect(sent[0]).toMatchObject({ sessionId: 'local1', localId: 'handoff-rnd', displayText: '交接给「Target」' })
        expect(sent[0].text).toContain('to: "target1", machine_id: "m2"')
        expect(sent[0].text).toContain('archive_after: true')
        expect(sent[0].text).toContain('handoff_send')
        expect(sent[0].text).toContain('Note from the user: be brief')
    })

    it('refuses same / invalid ids and answers running for a handoff in progress', async () => {
        const { d, sent } = deps({ openItems: async () => [running('handoff', 9_900)] })
        expect((await requestHandoff({ from: 'a1', to: 'a1' }, d)).state).toBe('error')
        expect((await requestHandoff({ from: 'a1', to: 'bad id' }, d)).error).toMatch(/spawn it first/)
        expect(await requestHandoff({ from: 'local1', to: 't1' }, d)).toEqual({ sessionId: 'local1', state: 'running' })
        expect(sent).toEqual([])
    })

    it('board unavailable → no idempotency read, still sends', async () => {
        const deliverRemote = vi.fn(async (sessionId: string) => live(sessionId))
        const { d } = deps({ openItems: async () => [], deliverRemote })
        expect((await requestHandoff({ from: 'remote9', to: 't1' }, d)).state).toBe('queued')
        expect(deliverRemote).toHaveBeenCalledOnce()
    })

    it('offline targets are resumed on their machine before the turn; archived / missing ones are refused unsent', async () => {
        const { d, sent } = deps({
            readState: async (id) => id === 'gone1' ? { found: false } : { found: true, archivedAt: id === 'arch1' ? 123 : null },
        })
        const results = await requestWrapup(['local1', 'remote1', 'arch1', 'gone1'], {}, d)
        expect(results.map((r) => r.state)).toEqual(['queued', 'queued', 'error', 'error'])
        expect(results[2].error).toMatch(/archived/)
        expect(results[3].error).toMatch(/not found/)
        expect(sent.map((s) => [s.sessionId, s.resume])).toEqual([['local1', true], ['remote1', true]])
        expect((await requestHandoff({ from: 'arch1', to: 't1' }, d)).error).toMatch(/archived/)
        expect(sent).toHaveLength(2)
    })
})

describe('B-915c sessions wrapup: upgrade hint for an older wrapper (QA81 P3)', () => {
    it('flags a queued session whose live capabilities lack wrapup-v1; never a running / error one or one it cannot read', async () => {
        const caps: Record<string, readonly string[] | null> = { old: ['project-v1'], bare: [], fresh: ['attention-v1', 'wrapup-v1'], foreign: null }
        const asked: string[] = []
        const stale = await wrapupUpgradeNeeded([
            { sessionId: 'old', state: 'queued' },
            { sessionId: 'bare', state: 'queued' },
            { sessionId: 'fresh', state: 'queued' },
            { sessionId: 'foreign', state: 'queued' },
            { sessionId: 'busy', state: 'running' },
            { sessionId: 'gone', state: 'error', error: 'x' },
        ], {
            readPersisted: () => ({ old: { encryptionKey: 'k' } as never }),
            readCapabilities: async (id, persisted) => { asked.push(`${id}:${persisted ? 'key' : '-'}`); return caps[id] ?? null },
        })
        expect(stale).toEqual(['old', 'bare'])
        expect(asked).toEqual(['old:key', 'bare:-', 'fresh:-', 'foreign:-'])
    })

    it('uses the Web toast wording', () => {
        expect(WRAPUP_UPGRADE_HINT).toBe('Sent. Upgrade the CLI on that machine to get a wrap-up card on the Briefing; for now the result stays in the chat.')
    })
})
