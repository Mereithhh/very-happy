import { describe, expect, it, vi } from 'vitest'
import { createMainAgentLifecycle, type MainAgentLifecycleDeps } from './mainAgentLifecycle'

function deps(over: Partial<MainAgentLifecycleDeps> = {}) {
    const base: MainAgentLifecycleDeps = {
        selfId: () => 'main',
        requestWrapup: vi.fn(async (ids: readonly string[]) => ids.map(sessionId => ({ sessionId, state: 'queued' as const }))),
        requestHandoff: vi.fn(async (request) => ({ sessionId: request.from, state: 'queued' as const })),
        readSource: vi.fn(async () => ({ path: '/repo/a', flavor: 'codex', title: 'Fix login', machineId: 'm1' })),
        selfMachineId: async () => 'm1',
        spawn: vi.fn(async () => ({ sessionId: 'fresh' })),
        restart: vi.fn(async () => ({ ok: true as const, state: 'queued' as const, targetVersion: '0.2.212' })),
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

    it('handoff to new: spawns in from\'s directory with its agent, then hands off to it; a retry reuses the session', async () => {
        const d = deps()
        const life = createMainAgentLifecycle(d)
        expect(await life.handoff!({ from: 'a', to: 'new', requestId: 'r' })).toEqual({ ok: true, from: 'a', to: 'fresh', state: 'queued' })
        expect(d.spawn).toHaveBeenCalledWith('/repo/a', { agent: 'codex', title: 'Handoff: Fix login' })
        expect(d.requestHandoff).toHaveBeenCalledWith({ from: 'a', to: 'fresh', toTitle: 'Handoff: Fix login', requestId: 'r' })
        await life.handoff!({ from: 'a', to: 'new', requestId: 'r' })
        expect(d.spawn).toHaveBeenCalledTimes(1)
        expect((d.requestHandoff as any).mock.calls[1][0]).toMatchObject({ to: 'fresh', requestId: 'r' })
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
        const terminal = createMainAgentLifecycle(deps({ restart: async () => ({ ok: false, code: 'local-terminal' }) }))
        expect(await terminal.restart!({ sessionId: 's', when: 'now', requestId: 'r' })).toMatchObject({ ok: false, error: expect.stringContaining('own terminal') })
        const again = createMainAgentLifecycle(deps({ restart: async () => ({ ok: true, state: 'already-queued' }) }))
        expect(await again.restart!({ sessionId: 's', when: 'idle', requestId: 'r' })).toEqual({ ok: true, sessionId: 's', scheduled: 'idle', already: true })
    })
})
