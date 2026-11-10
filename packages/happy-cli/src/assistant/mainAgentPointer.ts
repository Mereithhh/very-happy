/**
 * B-916b: account KV `vh.main-agent.v1` — which session is the account's main
 * agent (specs/2026-11-main-agent.md §2.1). One per account:
 *
 *  - before the daemon spawns (or re-attaches) its assistant it reads the
 *    pointer; a pointer naming ANOTHER machine refuses the spawn
 *    (`main_agent_on_other_machine`) — the owner moves it in settings;
 *  - after a spawn / forceNew / re-attach it writes `{machineId, sessionId}`,
 *    bumping `generation` when the session changed. Optimistic concurrency on
 *    the KV version: one re-read and retry on conflict, then give up (the next
 *    spawn writes again).
 *
 * The value is UTF-8 JSON in base64 (the `vh.board-tasks.v1` convention). A
 * reader ignores unknown fields and treats a broken pointer as absent; a KV
 * that cannot be reached (old server, network) never blocks a spawn.
 */

export const MAIN_AGENT_KV_KEY = 'vh.main-agent.v1'

export type MainAgentPointer = { v: 1; machineId: string; sessionId: string | null; generation: number; updatedAt: number }

export type KvRead = { value: string; version: number } | null
export type KvIo = {
    /** null = no such key; throws when the KV cannot be reached. */
    get: (key: string) => Promise<KvRead>
    /** version -1 = create. 'conflict' = someone wrote first. Throws when unreachable. */
    set: (key: string, value: string, version: number) => Promise<'ok' | 'conflict'>
}

const ID = /^[A-Za-z0-9_-]{1,128}$/

export function parseMainAgentPointer(base64: string | null | undefined): MainAgentPointer | null {
    if (!base64) return null
    try {
        const raw = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))
        if (!raw || typeof raw !== 'object' || typeof raw.machineId !== 'string' || !ID.test(raw.machineId)) return null
        return {
            v: 1,
            machineId: raw.machineId,
            sessionId: typeof raw.sessionId === 'string' && ID.test(raw.sessionId) ? raw.sessionId : null,
            generation: Number.isSafeInteger(raw.generation) && raw.generation >= 0 ? raw.generation : 0,
            updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
        }
    } catch { return null }
}

export function encodeMainAgentPointer(pointer: MainAgentPointer): string {
    return Buffer.from(JSON.stringify(pointer), 'utf8').toString('base64')
}

export type MachineVerdict = { ok: true } | { ok: false; machineId: string }

/** Refuse only on a readable pointer that names another machine. */
export async function checkMainAgentMachine(io: KvIo, machineId: string): Promise<MachineVerdict> {
    let read: KvRead
    try { read = await io.get(MAIN_AGENT_KV_KEY) } catch { return { ok: true } }
    const pointer = parseMainAgentPointer(read?.value)
    return pointer && pointer.machineId !== machineId ? { ok: false, machineId: pointer.machineId } : { ok: true }
}

export const MAIN_AGENT_ON_OTHER_MACHINE = 'main_agent_on_other_machine'
export function mainAgentOnOtherMachineMessage(otherMachineId: string): string {
    return `${MAIN_AGENT_ON_OTHER_MACHINE}: this account's main agent runs on machine ${otherMachineId}. Open it there, or move it to this machine in the main agent settings.`
}

export type RecordOutcome = 'written' | 'unchanged' | 'conflict' | 'other_machine' | 'unavailable'

/** Point the account's main agent at `sessionId` on `machineId`. */
export async function recordMainAgentSession(io: KvIo, machineId: string, sessionId: string, now: () => number = Date.now): Promise<RecordOutcome> {
    for (let attempt = 0; attempt < 2; attempt++) {
        let read: KvRead
        try { read = await io.get(MAIN_AGENT_KV_KEY) } catch { return 'unavailable' }
        const previous = parseMainAgentPointer(read?.value)
        // The owner moved it elsewhere between our check and now: theirs wins.
        if (previous && previous.machineId !== machineId) return 'other_machine'
        if (previous?.sessionId === sessionId) return 'unchanged'
        const next: MainAgentPointer = { v: 1, machineId, sessionId, generation: (previous?.generation ?? 0) + 1, updatedAt: now() }
        let result: 'ok' | 'conflict'
        try { result = await io.set(MAIN_AGENT_KV_KEY, encodeMainAgentPointer(next), read ? read.version : -1) } catch { return 'unavailable' }
        if (result === 'ok') return 'written'
    }
    return 'conflict'
}

/** The account KV over HTTP (`/v1/kv`), with the daemon's token. */
export function httpKvIo(serverUrl: string, token: () => string, fetchImpl: typeof fetch = fetch): KvIo {
    const headers = () => ({ authorization: `Bearer ${token()}`, 'content-type': 'application/json' })
    return {
        async get(key) {
            const response = await fetchImpl(`${serverUrl}/v1/kv/${encodeURIComponent(key)}`, { headers: headers(), redirect: 'error', signal: AbortSignal.timeout(5000) })
            if (response.status === 404) return null
            if (!response.ok) throw new Error(`kv ${response.status}`)
            const body = await response.json() as { value?: unknown; version?: unknown }
            return typeof body.value === 'string' && typeof body.version === 'number' ? { value: body.value, version: body.version } : null
        },
        async set(key, value, version) {
            const response = await fetchImpl(`${serverUrl}/v1/kv`, { method: 'POST', headers: headers(), redirect: 'error', body: JSON.stringify({ mutations: [{ key, value, version }] }), signal: AbortSignal.timeout(5000) })
            if (response.status === 409) return 'conflict'
            if (!response.ok) throw new Error(`kv ${response.status}`)
            return 'ok'
        },
    }
}
