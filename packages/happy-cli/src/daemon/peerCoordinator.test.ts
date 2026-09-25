import { describe, expect, it, vi } from 'vitest'
import { createPeerCoordinator } from './peerCoordinator'
import type { TrackedSession } from './types'
import type { PersistedSession } from '@/persistence'
import { parsePeerMessage } from '@/sessions/peerMessage'

const child = (id: string, pid: number, meta: Record<string, unknown> = {}): TrackedSession => ({
    startedBy: 'daemon', happySessionId: id, pid,
    happySessionMetadataFromLocalWebhook: { path: '/repo', host: 'h', homeDir: '/', happyHomeDir: '/', happyLibDir: '/', happyToolsDir: '/', flavor: 'claude', ...meta } as TrackedSession['happySessionMetadataFromLocalWebhook'],
})
const key = (): PersistedSession => ({ encryptionKey: 'k', encryptionVariant: 'dataKey', seq: 0, metadataVersion: 0, agentStateVersion: 0, savedAt: 1, metadata: {} as PersistedSession['metadata'] })
type SendCall = [string, PersistedSession, string, string, Record<string, unknown>]

describe('peer coordinator (B-497)', () => {
    function setup(options: { maxNoticesPerPair?: number } = {}) {
        let now = 1_000
        const children = [child('a', 1, { summary: { text: 'Alpha', updatedAt: 1 } }), child('b', 2, { flavor: 'codex', path: '/repo/pkg' })]
        const send = vi.fn(async () => undefined)
        const timers: Array<() => void> = []
        const coordinator = createPeerCoordinator({
            getChildren: () => children,
            getMirrors: () => [{ sessionId: 'm', cwd: '/repo', title: 'term' }],
            now: () => now,
            windowMs: 60_000,
            coalesceMs: 10_000,
            maxNoticesPerPair: options.maxNoticesPerPair,
            readPersisted: () => ({ a: key(), b: key() }),
            send,
            liveTitle: async (sessionId) => (sessionId === 'b' ? 'Live B' : undefined),
            normalize: (path, cwd) => (path.startsWith('/') ? path : `${cwd}/${path}`).replace('/link/', '/real/'),
            schedule: (fn) => { timers.push(fn); return {} },
        })
        const fire = async () => { const due = timers.splice(0); for (const fn of due) fn(); await coordinator.flush() }
        return { coordinator, send, children, timers, fire, tick: (ms: number) => { now += ms } }
    }

    it('lists managed children and active mirrors with their recent edits', () => {
        const { coordinator } = setup()
        coordinator.onEdit({ sessionId: 'a', path: 'src/x.ts', tool: 'Edit' })
        expect(coordinator.list()).toEqual([
            { sessionId: 'a', kind: 'managed', pid: 1, cwd: '/repo', flavor: 'claude', title: 'Alpha', edits: [{ path: '/repo/src/x.ts', tool: 'Edit', at: 1_000 }] },
            { sessionId: 'b', kind: 'managed', pid: 2, cwd: '/repo/pkg', flavor: 'codex', edits: [] },
            { sessionId: 'm', kind: 'mirror', flavor: 'terminal-mirror', cwd: '/repo', title: 'term', edits: [] },
        ])
    })

    it('notifies both sides once (after the coalesce delay) when a second session edits the same real path', async () => {
        const { coordinator, send, tick, timers, fire } = setup()
        expect(coordinator.onEdit({ sessionId: 'a', path: '/link/repo/src/x.ts', tool: 'Edit' })).toEqual([])
        tick(30_000)
        const conflicts = coordinator.onEdit({ sessionId: 'b', path: '/real/repo/src/x.ts', tool: 'CodexPatch' })
        expect(conflicts).toHaveLength(1)
        expect(send).not.toHaveBeenCalled() // nothing before the coalesce window
        expect(timers).toHaveLength(1)
        await fire()
        expect(send).toHaveBeenCalledTimes(2)
        const calls = send.mock.calls as unknown as SendCall[]
        const toB = calls.find((c) => c[0] === 'b')!
        const toA = calls.find((c) => c[0] === 'a')!
        expect(toB[3]).toBe('edit-conflict')
        expect(toB[4]).toMatchObject({ sentFrom: 'session-peer', delivery: 'steer' })
        expect(parsePeerMessage(toB[2])).toMatchObject({ kind: 'conflict', path: '/real/repo/src/x.ts', paths: ['/real/repo/src/x.ts'], peer: { sessionId: 'a', title: 'Alpha', flavor: 'claude' }, peerEditedAgoMs: 30_000 })
        expect(parsePeerMessage(toA[2])).toMatchObject({ kind: 'conflict', path: '/real/repo/src/x.ts', peer: { sessionId: 'b', title: 'Live B', flavor: 'codex', cwd: '/repo/pkg' }, peerEditedAgoMs: 0 })
        expect(String(toA[4].localId)).not.toBe(String(toB[4].localId))
        // Same pair, same file, inside the window: silence.
        tick(1_000)
        expect(coordinator.onEdit({ sessionId: 'a', path: '/real/repo/src/x.ts', tool: 'Edit' })).toEqual([])
    })

    it('coalesces several files of one pair into a single notice per side', async () => {
        const { coordinator, send, tick, fire } = setup()
        for (const file of ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']) coordinator.onEdit({ sessionId: 'a', path: file, tool: 'Edit' })
        tick(2_000)
        for (const file of ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']) { coordinator.onEdit({ sessionId: 'b', path: file, tool: 'Edit' }); tick(500) }
        await fire()
        expect(send).toHaveBeenCalledTimes(2)
        const toA = (send.mock.calls as unknown as SendCall[]).find((c) => c[0] === 'a')!
        expect(parsePeerMessage(toA[2])).toMatchObject({ kind: 'conflict', path: '/repo/a.ts', paths: ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'] })
        expect(toA[2]).toContain('more 2')
    })

    it('caps notices per pair per window', async () => {
        const { coordinator, send, tick, fire } = setup({ maxNoticesPerPair: 2 })
        for (let i = 0; i < 4; i++) {
            coordinator.onEdit({ sessionId: 'a', path: `/repo/f${i}.ts`, tool: 'Edit' })
            tick(100)
            coordinator.onEdit({ sessionId: 'b', path: `/repo/f${i}.ts`, tool: 'Edit' })
            await fire()
            tick(11_000)
        }
        expect(send).toHaveBeenCalledTimes(4) // 2 notices × 2 sides; the 3rd and 4th were dropped
        tick(60_000)
        coordinator.onEdit({ sessionId: 'a', path: '/repo/g.ts', tool: 'Edit' })
        tick(100)
        coordinator.onEdit({ sessionId: 'b', path: '/repo/g.ts', tool: 'Edit' })
        await fire()
        expect(send).toHaveBeenCalledTimes(6) // window lapsed → budget restored
    })

    it('ignores replayed history: an edit older than the window never conflicts, a future stamp is clamped', async () => {
        const { coordinator, send, tick, fire } = setup()
        // b edited x.ts "now"; a's transcript replays an Edit from an hour ago.
        coordinator.onEdit({ sessionId: 'b', path: '/repo/x.ts', tool: 'Edit' })
        expect(coordinator.onEdit({ sessionId: 'a', path: '/repo/x.ts', tool: 'Edit', at: 1_000 - 3_600_000 })).toEqual([])
        expect(coordinator.list().find((s) => s.sessionId === 'a')!.edits).toEqual([])
        // A stamp from the future counts as now.
        tick(5_000)
        expect(coordinator.onEdit({ sessionId: 'a', path: '/repo/x.ts', tool: 'Edit', at: 9_999_999 })).toHaveLength(1)
        await fire()
        const toB = (send.mock.calls as unknown as SendCall[]).find((c) => c[0] === 'b')!
        expect(parsePeerMessage(toB[2])).toMatchObject({ peerEditedAgoMs: 0 })
    })

    it('tells the managed side about a mirror edit but never messages the mirror', async () => {
        const { coordinator, send, fire } = setup()
        coordinator.onEdit({ sessionId: 'm', path: '/repo/y.ts', tool: 'Write' })
        expect(coordinator.onEdit({ sessionId: 'a', path: '/repo/y.ts', tool: 'Edit' })).toHaveLength(1)
        await fire()
        expect(send).toHaveBeenCalledTimes(1)
        const [to, , text] = send.mock.calls[0] as unknown as [string, unknown, string]
        expect(to).toBe('a')
        expect(text).toContain('agent terminal-mirror')
        expect(text).toContain('cannot be messaged')
    })

    it('ignores edits from sessions it does not know and forgets ended ones (pending notices included)', async () => {
        const { coordinator, send, children, fire } = setup()
        expect(coordinator.onEdit({ sessionId: 'ghost', path: '/repo/z.ts', tool: 'Edit' })).toEqual([])
        coordinator.onEdit({ sessionId: 'a', path: '/repo/z.ts', tool: 'Edit' })
        expect(coordinator.onEdit({ sessionId: 'b', path: '/repo/z.ts', tool: 'Edit' })).toHaveLength(1)
        coordinator.forget('a')
        await fire()
        expect(send).not.toHaveBeenCalled()
        children.splice(0, 1)
        expect(coordinator.onEdit({ sessionId: 'b', path: '/repo/z.ts', tool: 'Edit' })).toEqual([])
    })
})
