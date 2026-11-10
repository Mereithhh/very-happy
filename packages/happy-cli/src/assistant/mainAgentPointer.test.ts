import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
    MAIN_AGENT_KV_KEY, checkMainAgentMachine, encodeMainAgentPointer, httpKvIo, mainAgentOnOtherMachineMessage,
    parseMainAgentPointer, recordMainAgentSession, type KvIo,
} from './mainAgentPointer'

function memoryKv(initial?: { value: string; version: number }, opts: { conflicts?: number; down?: boolean } = {}) {
    let row = initial ? { ...initial } : null
    let conflicts = opts.conflicts ?? 0
    const writes: Array<{ value: string; version: number }> = []
    const io: KvIo = {
        get: async (key) => { expect(key).toBe(MAIN_AGENT_KV_KEY); if (opts.down) throw new Error('down'); return row ? { ...row } : null },
        set: async (_key, value, version) => {
            if (opts.down) throw new Error('down')
            if (conflicts > 0) { conflicts--; row = { value: encodeMainAgentPointer({ v: 1, machineId: 'm1', sessionId: 'raced', generation: 7, updatedAt: 1 }), version: (row?.version ?? -1) + 1 }; return 'conflict' }
            if ((row ? row.version : -1) !== version) return 'conflict'
            writes.push({ value, version }); row = { value, version: version + 1 }; return 'ok'
        },
    }
    return { io, writes, current: () => parseMainAgentPointer(row?.value) }
}
const pointer = (machineId: string, sessionId: string | null, generation = 1) => ({ value: encodeMainAgentPointer({ v: 1, machineId, sessionId, generation, updatedAt: 5 }), version: 3 })

describe('parseMainAgentPointer', () => {
    it('round-trips and is lenient with unknown or broken fields', () => {
        expect(parseMainAgentPointer(encodeMainAgentPointer({ v: 1, machineId: 'm1', sessionId: 's1', generation: 2, updatedAt: 9 }))).toEqual({ v: 1, machineId: 'm1', sessionId: 's1', generation: 2, updatedAt: 9 })
        const loose = Buffer.from(JSON.stringify({ machineId: 'm1', sessionId: 42, generation: -3, extra: true })).toString('base64')
        expect(parseMainAgentPointer(loose)).toEqual({ v: 1, machineId: 'm1', sessionId: null, generation: 0, updatedAt: 0 })
        expect(parseMainAgentPointer(Buffer.from('{oops').toString('base64'))).toBeNull()
        expect(parseMainAgentPointer(Buffer.from(JSON.stringify({ machineId: '../x' })).toString('base64'))).toBeNull()
        expect(parseMainAgentPointer(null)).toBeNull()
    })
})

describe('checkMainAgentMachine', () => {
    it('refuses only when a readable pointer names another machine', async () => {
        expect(await checkMainAgentMachine(memoryKv(pointer('m2', 's9')).io, 'm1')).toEqual({ ok: false, machineId: 'm2' })
        expect(await checkMainAgentMachine(memoryKv(pointer('m1', 's9')).io, 'm1')).toEqual({ ok: true })
        expect(await checkMainAgentMachine(memoryKv().io, 'm1')).toEqual({ ok: true })
        expect(await checkMainAgentMachine(memoryKv({ value: 'not base64 json', version: 1 }).io, 'm1')).toEqual({ ok: true })
        expect(await checkMainAgentMachine(memoryKv(undefined, { down: true }).io, 'm1')).toEqual({ ok: true })
        expect(mainAgentOnOtherMachineMessage('m2')).toMatch(/^main_agent_on_other_machine: .*m2/)
    })
})

describe('recordMainAgentSession', () => {
    it('creates the pointer, then bumps generation only when the session changes', async () => {
        const kv = memoryKv()
        expect(await recordMainAgentSession(kv.io, 'm1', 's1', () => 100)).toBe('written')
        expect(kv.writes[0].version).toBe(-1)
        expect(kv.current()).toEqual({ v: 1, machineId: 'm1', sessionId: 's1', generation: 1, updatedAt: 100 })
        expect(await recordMainAgentSession(kv.io, 'm1', 's1')).toBe('unchanged')
        expect(await recordMainAgentSession(kv.io, 'm1', 's2', () => 200)).toBe('written')
        expect(kv.current()).toEqual({ v: 1, machineId: 'm1', sessionId: 's2', generation: 2, updatedAt: 200 })
        expect(kv.writes).toHaveLength(2)
    })

    it('fills a pointer the settings page left without a session', async () => {
        const kv = memoryKv(pointer('m1', null, 4))
        expect(await recordMainAgentSession(kv.io, 'm1', 's1', () => 7)).toBe('written')
        expect(kv.writes[0].version).toBe(3)
        expect(kv.current()?.generation).toBe(5)
    })

    it('re-reads once on a conflict, then gives up; never overwrites another machine', async () => {
        const once = memoryKv(pointer('m1', 'old'), { conflicts: 1 })
        expect(await recordMainAgentSession(once.io, 'm1', 's1')).toBe('written')
        expect(once.current()).toMatchObject({ sessionId: 's1', generation: 8 })
        const always = memoryKv(pointer('m1', 'old'), { conflicts: 5 })
        expect(await recordMainAgentSession(always.io, 'm1', 's1')).toBe('conflict')
        const moved = memoryKv(pointer('m2', 'x'))
        expect(await recordMainAgentSession(moved.io, 'm1', 's1')).toBe('other_machine')
        expect(moved.writes).toEqual([])
        expect(await recordMainAgentSession(memoryKv(undefined, { down: true }).io, 'm1', 's1')).toBe('unavailable')
    })
})

describe('httpKvIo', () => {
    it('speaks /v1/kv: 404 = absent, 409 = conflict, a batch of one mutation', async () => {
        const calls: Array<{ url: string; init: any }> = []
        const answers = [new Response('', { status: 404 }), new Response(JSON.stringify({ key: MAIN_AGENT_KV_KEY, value: 'dmFs', version: 4 })), new Response('{}', { status: 409 }), new Response('{"success":true}')]
        const io = httpKvIo('https://vh.test', () => 'tok', (async (url: string, init: any) => { calls.push({ url, init }); return answers.shift()! }) as any)
        expect(await io.get(MAIN_AGENT_KV_KEY)).toBeNull()
        expect(await io.get(MAIN_AGENT_KV_KEY)).toEqual({ value: 'dmFs', version: 4 })
        expect(await io.set(MAIN_AGENT_KV_KEY, 'dmFs', 4)).toBe('conflict')
        expect(await io.set(MAIN_AGENT_KV_KEY, 'dmFs', -1)).toBe('ok')
        expect(calls[0].url).toBe('https://vh.test/v1/kv/vh.main-agent.v1')
        expect(calls[0].init.headers.authorization).toBe('Bearer tok')
        expect(calls[3].url).toBe('https://vh.test/v1/kv')
        expect(JSON.parse(calls[3].init.body)).toEqual({ mutations: [{ key: MAIN_AGENT_KV_KEY, value: 'dmFs', version: -1 }] })
    })
})

describe('daemon wiring', () => {
    // Source assertions (verified with scripts/dev/mutation-check.mjs): the daemon checks before and records after an assistant spawn.
    const source = readFileSync(new URL('../daemon/run.ts', import.meta.url), 'utf8')
    it('refuses an assistant spawn when the main agent is on another machine, and records the session after', () => {
        expect(source).toContain('const verdict = await checkMainAgentMachine(mainAgentKv, machineId);')
        expect(source).toContain("return { type: 'error', errorMessage: mainAgentOnOtherMachineMessage(verdict.machineId), notStarted: true };")
        expect(source).toContain('void recordMainAgentSession(mainAgentKv, machineId, sessionId)')
        expect(source.indexOf('checkMainAgentMachine(mainAgentKv')).toBeLessThan(source.indexOf('assistantSpawnGate.replace('))
    })
})
