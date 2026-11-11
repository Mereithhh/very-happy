import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMainAgentLifecycle, fileHandoffNewStore, handoffNewKey, restartRefusalText, type HandoffNewStore, type MainAgentLifecycleDeps } from './mainAgentLifecycle'

function memoryStore(): HandoffNewStore & { map: Map<string, string> } {
    const map = new Map<string, string>()
    return { map, get: (k) => map.get(k) ?? null, set: (k, v) => { map.set(k, v) } }
}

function deps(over: Partial<MainAgentLifecycleDeps> = {}) {
    const base: MainAgentLifecycleDeps = {
        selfId: () => 'main',
        requestWrapup: vi.fn(async (ids: readonly string[]) => ids.map(sessionId => ({ sessionId, state: 'queued' as const }))),
        requestHandoff: vi.fn(async (request) => ({ sessionId: request.from, state: 'queued' as const })),
        readSource: vi.fn(async () => ({ path: '/repo/a', flavor: 'codex', title: 'Fix login', machineId: 'm1' })),
        selfMachineId: async () => 'm1',
        spawn: vi.fn(async () => ({ sessionId: 'fresh' })),
        restart: vi.fn(async () => ({ ok: true as const, state: 'queued' as const, targetVersion: '0.2.212' })),
        handoffNew: memoryStore(),
        sessionUsable: async () => true,
    }
    return { ...base, ...over }
}

describe('main agent lifecycle (B-919)', () => {
    it('wrap-up: the B-915 request for exactly the named session, self excluded; short receipt', async () => {
        const d = deps()
        const life = createMainAgentLifecycle(d)
        expect(await life.wrapup!({ sessionId: 's1', requestId: 'r1' })).toEqual({ ok: true, sessionId: 's1', state: 'queued' })
        expect(d.requestWrapup).toHaveBeenCalledWith(['s1'], { requestId: 'r1', self: 'main' })
        const refused = createMainAgentLifecycle(deps({ requestWrapup: async () => [{ sessionId: 's1', state: 'error', error: `archived ${'x'.repeat(1000)}` }] }))
        const receipt = await refused.wrapup!({ sessionId: 's1', requestId: 'r2' })
        expect(receipt).toMatchObject({ ok: false, sessionId: 's1' })
        expect(JSON.stringify(receipt).length).toBeLessThan(400)
    })

    it('handoff to an existing session: one B-915 request, no spawn', async () => {
        const d = deps()
        expect(await createMainAgentLifecycle(d).handoff!({ from: 'a', to: 'b', note: 'n', requestId: 'r' })).toEqual({ ok: true, from: 'a', to: 'b', state: 'queued' })
        expect(d.requestHandoff).toHaveBeenCalledWith({ from: 'a', to: 'b', note: 'n', requestId: 'r' })
        expect(d.spawn).not.toHaveBeenCalled()
    })

    it('handoff to new: spawns in from\'s directory with its agent, then hands off to it; a retry reuses the session (deduped)', async () => {
        const d = deps()
        const life = createMainAgentLifecycle(d)
        expect(await life.handoff!({ from: 'a', to: 'new', requestId: 'r' })).toEqual({ ok: true, from: 'a', to: 'fresh', state: 'queued' })
        expect(d.spawn).toHaveBeenCalledWith('/repo/a', { agent: 'codex', title: 'Handoff: Fix login' })
        expect(d.requestHandoff).toHaveBeenCalledWith({ from: 'a', to: 'fresh', toTitle: 'Handoff: Fix login', requestId: 'r' })
        expect(await life.handoff!({ from: 'a', to: 'new', requestId: 'r' })).toEqual({ ok: true, from: 'a', to: 'fresh', state: 'queued', deduped: true })
        expect(d.spawn).toHaveBeenCalledTimes(1)
        expect((d.requestHandoff as any).mock.calls[1][0]).toMatchObject({ to: 'fresh', requestId: 'r' })
        // Another requestId is another request: a second new session.
        await life.handoff!({ from: 'a', to: 'new', requestId: 'r2' })
        expect(d.spawn).toHaveBeenCalledTimes(2)
    })

    it('QA P2-3: handoff to new across wrapper processes — the requestId → session record is on disk; a gone session is not reused', async () => {
        const file = join(mkdtempSync(join(tmpdir(), 'b919-')), 'assistant', 'handoff-new.json')
        const first = deps({ handoffNew: fileHandoffNewStore(file) })
        expect(await createMainAgentLifecycle(first).handoff!({ from: 'a', to: 'new', requestId: 'r' })).toMatchObject({ ok: true, to: 'fresh' })
        // A new process (restarted wrapper): new lifecycle, new store object on the same file.
        const second = deps({ handoffNew: fileHandoffNewStore(file), spawn: vi.fn(async () => ({ sessionId: 'second' })) })
        expect(await createMainAgentLifecycle(second).handoff!({ from: 'a', to: 'new', requestId: 'r' })).toEqual({ ok: true, from: 'a', to: 'fresh', state: 'queued', deduped: true })
        expect(second.spawn).not.toHaveBeenCalled()
        // The remembered session was archived / deleted since → spawn a fresh one.
        const third = deps({ handoffNew: fileHandoffNewStore(file), sessionUsable: async () => false, spawn: vi.fn(async () => ({ sessionId: 'third' })) })
        expect(await createMainAgentLifecycle(third).handoff!({ from: 'a', to: 'new', requestId: 'r' })).toMatchObject({ ok: true, to: 'third' })
        expect(fileHandoffNewStore(file).get(handoffNewKey('a', 'r'))).toBe('third')
        // Records expire after 7 days.
        expect(fileHandoffNewStore(file, () => Date.now() + 8 * 24 * 3600 * 1000).get(handoffNewKey('a', 'r'))).toBeNull()
    })

    it('QA P3-1: the main agent is neither the source nor the target of a handoff', async () => {
        const d = deps()
        const life = createMainAgentLifecycle(d)
        expect(await life.handoff!({ from: 'main', to: 'b', requestId: 'r' })).toMatchObject({ ok: false, error: expect.stringContaining('from is that is the main agent itself') })
        expect(await life.handoff!({ from: 'a', to: 'main', requestId: 'r' })).toMatchObject({ ok: false, error: expect.stringContaining('to is that is the main agent itself') })
        expect(await life.handoff!({ from: 'main', to: 'new', requestId: 'r' })).toMatchObject({ ok: false })
        expect(d.requestHandoff).not.toHaveBeenCalled()
        expect(d.spawn).not.toHaveBeenCalled()
    })

    it('QA P2-1: a deduped B-915 answer is passed through as deduped', async () => {
        const d = deps({
            requestWrapup: async () => [{ sessionId: 's1', state: 'done', deduped: true }],
            requestHandoff: async () => ({ sessionId: 'a', state: 'running', deduped: true }),
        })
        const life = createMainAgentLifecycle(d)
        expect(await life.wrapup!({ sessionId: 's1', requestId: 'r' })).toEqual({ ok: true, sessionId: 's1', state: 'done', deduped: true })
        expect(await life.handoff!({ from: 'a', to: 'b', requestId: 'r' })).toEqual({ ok: true, from: 'a', to: 'b', state: 'running', deduped: true })
    })

    it('handoff to new: from on another machine (or unknown here) is refused before anything is spawned', async () => {
        for (const readSource of [async () => ({ path: '/x', flavor: 'claude', title: null, machineId: 'm2' }), async () => null]) {
            const d = deps({ readSource })
            const r = await createMainAgentLifecycle(d).handoff!({ from: 'a', to: 'new', requestId: 'r' })
            expect(r).toMatchObject({ ok: false, from: 'a', to: 'new' })
            expect((r as any).error).toMatch(/not on this machine/)
            expect(d.spawn).not.toHaveBeenCalled()
            expect(d.requestHandoff).not.toHaveBeenCalled()
        }
        const failing = deps({ spawn: async () => ({ error: 'directory missing' }) })
        expect(await createMainAgentLifecycle(failing).handoff!({ from: 'a', to: 'new', requestId: 'r' })).toMatchObject({ ok: false, error: expect.stringContaining('directory missing') })
    })

    it('restart: the daemon decides; refusals become one readable line', async () => {
        const d = deps()
        expect(await createMainAgentLifecycle(d).restart!({ sessionId: 's', when: 'idle', requestId: 'r' })).toEqual({ ok: true, sessionId: 's', scheduled: 'idle', targetVersion: '0.2.212' })
        expect(d.restart).toHaveBeenCalledWith('s', 'idle')
        const busy = createMainAgentLifecycle(deps({ restart: async () => ({ ok: false, code: 'busy', error: 'busy:turn-active' }) }))
        expect(await busy.restart!({ sessionId: 's', when: 'now', requestId: 'r' })).toEqual({ ok: false, sessionId: 's', error: expect.stringContaining('use when = idle') })
        expect(restartRefusalText({ code: 'busy', error: 'busy:quiet' })).toContain('its last turn ended moments ago')
        expect(restartRefusalText({ code: 'busy', error: 'busy:automation-run' })).toContain('an automation run is using it')
        expect(restartRefusalText({ code: 'busy', error: 'busy:observing' })).toContain('just started and does not know yet whether it is busy')
        const terminal = createMainAgentLifecycle(deps({ restart: async () => ({ ok: false, code: 'local-terminal' }) }))
        expect(await terminal.restart!({ sessionId: 's', when: 'now', requestId: 'r' })).toMatchObject({ ok: false, error: expect.stringContaining('own terminal') })
        const again = createMainAgentLifecycle(deps({ restart: async () => ({ ok: true, state: 'already-queued' }) }))
        expect(await again.restart!({ sessionId: 's', when: 'idle', requestId: 'r' })).toEqual({ ok: true, sessionId: 's', scheduled: 'idle', already: true })
    })
})
