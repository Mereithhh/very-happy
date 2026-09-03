import { describe, expect, it, vi } from 'vitest'
import {
    buildPermissionRpcPayload,
    interpretPermissionAck,
    pendingRequestsOf,
    resolvePermissionRequest,
    PERMISSION_RPC_TIMEOUT_MS,
    type PermissionRpcPayload,
} from './permissionOps'
import { decodeBase64, decrypt, encodeBase64, encrypt, getRandomBytes } from '@/api/encryption'
import type { PersistedSession } from '@/persistence'
import type { AgentState } from '@/api/types'
import type { RpcCallAck, UserRpcTransport } from '@/api/userSocket'

const SID = 'cmtl3c0x7001vqr29o8nmclno'
const REQ = 'req-1'

describe('buildPermissionRpcPayload — mirrors the web permission card', () => {
    it('approve is a bare {id, approved:true, decision:approved} — no mode, no allowTools (rule 14)', () => {
        const payload = buildPermissionRpcPayload(REQ, { kind: 'approve' })
        expect(payload).toEqual({ id: REQ, approved: true, decision: 'approved' })
        expect(Object.keys(payload).sort()).toEqual(['approved', 'decision', 'id'])
    })

    it('--for-session becomes approved_for_session, still without mode', () => {
        expect(buildPermissionRpcPayload(REQ, { kind: 'approve', forSession: true }))
            .toEqual({ id: REQ, approved: true, decision: 'approved_for_session' })
    })

    it('deny is approved:false + decision:denied, reason only when given', () => {
        expect(buildPermissionRpcPayload(REQ, { kind: 'deny' })).toEqual({ id: REQ, approved: false, decision: 'denied' })
        expect(buildPermissionRpcPayload(REQ, { kind: 'deny', reason: 'out of scope' }))
            .toEqual({ id: REQ, approved: false, decision: 'denied', reason: 'out of scope' })
    })
})

describe('interpretPermissionAck — server ack + rule-17 envelope', () => {
    const identity = (encrypted: string) => JSON.parse(encrypted)

    it('classifies the server refusals: offline / timeout / other', () => {
        expect(interpretPermissionAck({ ok: false, error: 'RPC method not available' }, identity).status).toBe('offline')
        expect(interpretPermissionAck({ ok: false, error: 'operation has timed out' }, identity).status).toBe('timeout')
        expect(interpretPermissionAck({ ok: false, error: 'RPC target disconnected' }, identity).status).toBe('timeout')
        expect(interpretPermissionAck({ ok: false, error: 'RPC rate limit reached' }, identity)).toEqual({ status: 'rejected', message: 'RPC rate limit reached' })
        expect(interpretPermissionAck({ ok: false }, identity)).toEqual({ status: 'rejected', message: 'RPC call failed' })
    })

    it('a successful ack whose decrypted body is {error} is a handler error, not success', () => {
        const ack: RpcCallAck = { ok: true, result: JSON.stringify({ error: 'boom' }) }
        expect(interpretPermissionAck(ack, identity)).toEqual({ status: 'handler-error', message: 'boom' })
    })

    it('a successful ack with an empty / undecryptable / non-error body is acknowledged', () => {
        expect(interpretPermissionAck({ ok: true, result: '' }, identity).status).toBe('acknowledged')
        expect(interpretPermissionAck({ ok: true }, identity).status).toBe('acknowledged')
        expect(interpretPermissionAck({ ok: true, result: 'garbage' }, () => { throw new Error('bad key') }).status).toBe('acknowledged')
        expect(interpretPermissionAck({ ok: true, result: JSON.stringify({ ok: 1 }) }, identity).status).toBe('acknowledged')
    })
})

describe('pendingRequestsOf', () => {
    it('returns the pending requests oldest first with waitingMs from now', () => {
        const state: AgentState = {
            requests: {
                b: { tool: 'Bash', arguments: {}, createdAt: 2_000 },
                a: { tool: 'Edit', arguments: {}, createdAt: 1_000, kind: 'tool' },
                q: { tool: 'AskUserQuestion', arguments: {} } as unknown as NonNullable<AgentState['requests']>[string],
            },
            completedRequests: { done: { tool: 'Bash', arguments: {}, createdAt: 0, completedAt: 1, status: 'approved' } },
        }
        expect(pendingRequestsOf(state, 5_000)).toEqual([
            { id: 'a', tool: 'Edit', kind: 'tool', createdAt: 1_000, waitingMs: 4_000 },
            { id: 'b', tool: 'Bash', createdAt: 2_000, waitingMs: 3_000 },
            { id: 'q', tool: 'AskUserQuestion' },
        ])
    })

    it('is empty for null / missing / malformed state', () => {
        expect(pendingRequestsOf(null, 0)).toEqual([])
        expect(pendingRequestsOf({}, 0)).toEqual([])
        expect(pendingRequestsOf({ requests: null } as unknown as AgentState, 0)).toEqual([])
    })
})

describe('resolvePermissionRequest — end to end over a fake transport', () => {
    const key = getRandomBytes(32)
    const persisted: PersistedSession = {
        encryptionKey: encodeBase64(key),
        encryptionVariant: 'dataKey',
        seq: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        savedAt: 1,
        metadata: { path: '/tmp', flavor: 'claude' } as PersistedSession['metadata'],
    }
    const pendingState: AgentState = { requests: { [REQ]: { tool: 'Bash', arguments: { command: 'ls' }, createdAt: 10 } } }
    const emptyState: AgentState = { requests: {}, completedRequests: {} }

    function fakeTransport(respond: (payload: PermissionRpcPayload, method: string) => RpcCallAck | Promise<RpcCallAck>) {
        const calls: Array<{ method: string; payload: PermissionRpcPayload; timeoutMs: number }> = []
        const transport: UserRpcTransport & { calls: typeof calls; closed: boolean } = {
            calls,
            closed: false,
            async rpcCall(request, timeoutMs) {
                const payload = decrypt(key, 'dataKey', decodeBase64(request.params)) as PermissionRpcPayload
                calls.push({ method: request.method, payload, timeoutMs })
                return await respond(payload, request.method)
            },
            close() { this.closed = true },
        }
        return transport
    }

    function deps(states: AgentState[], transport: UserRpcTransport) {
        const queue = [...states]
        return {
            now: () => 1_000,
            readPersisted: () => ({ [SID]: persisted }),
            fetchAgentState: vi.fn(async () => queue.length > 1 ? queue.shift()! : queue[0]),
            openTransport: vi.fn(async () => transport),
            bearerToken: async () => 'tok',
            sleep: async () => undefined,
            settleTimeoutMs: 0,
        }
    }

    it('encrypts the web-shaped payload with the local session key and sends it as `${sid}:permission`', async () => {
        const transport = fakeTransport(() => ({ ok: true, result: encodeBase64(encrypt(key, 'dataKey', undefined)) }))
        const result = await resolvePermissionRequest(SID, REQ, { kind: 'approve', forSession: true }, deps([pendingState, emptyState], transport))
        expect(transport.calls).toHaveLength(1)
        expect(transport.calls[0].method).toBe(`${SID}:permission`)
        expect(transport.calls[0].payload).toEqual({ id: REQ, approved: true, decision: 'approved_for_session' })
        expect(transport.calls[0].timeoutMs).toBe(PERMISSION_RPC_TIMEOUT_MS)
        expect(transport.closed).toBe(true)
        expect(result.outcome).toEqual({ status: 'acknowledged' })
        expect(result.settled).toBe(true)
    })

    it('refuses to send when the request is not pending — the wrapper would silently ignore it', async () => {
        const transport = fakeTransport(() => ({ ok: true }))
        await expect(resolvePermissionRequest(SID, 'stale', { kind: 'approve' }, deps([pendingState], transport)))
            .rejects.toThrow(/Request stale is not pending .* Pending request ids: req-1 \(Bash\)/)
        expect(transport.calls).toHaveLength(0)
    })

    it('refuses without a local key and says why (payload is encrypted with it)', async () => {
        const transport = fakeTransport(() => ({ ok: true }))
        const d = { ...deps([pendingState], transport), readPersisted: () => ({}) }
        await expect(resolvePermissionRequest(SID, REQ, { kind: 'deny' }, d)).rejects.toThrow(/No local key .* encrypted with it/)
        expect(d.openTransport).not.toHaveBeenCalled()
    })

    it('reports offline when no wrapper has the RPC registered, and closes the socket', async () => {
        const transport = fakeTransport(() => ({ ok: false, error: 'RPC method not available' }))
        const result = await resolvePermissionRequest(SID, REQ, { kind: 'deny', reason: 'no' }, deps([pendingState], transport))
        expect(result.outcome.status).toBe('offline')
        expect(result.settled).toBeUndefined()
        expect(transport.closed).toBe(true)
        expect(transport.calls[0].payload).toEqual({ id: REQ, approved: false, decision: 'denied', reason: 'no' })
    })

    it('a rejected emitWithAck (socket.io timeout) becomes a timeout outcome instead of a throw', async () => {
        const transport = fakeTransport(async () => { throw new Error('operation has timed out') })
        const result = await resolvePermissionRequest(SID, REQ, { kind: 'approve' }, deps([pendingState], transport))
        expect(result.outcome).toEqual({ status: 'timeout', message: 'operation has timed out' })
        expect(transport.closed).toBe(true)
    })

    it('terminates with a timeout outcome even when the transport never settles (owned deadline)', async () => {
        const transport = fakeTransport(() => new Promise<RpcCallAck>(() => { /* never */ }))
        const started = Date.now()
        const result = await resolvePermissionRequest(SID, REQ, { kind: 'approve' }, { ...deps([pendingState], transport), rpcTimeoutMs: 20 })
        expect(Date.now() - started).toBeLessThan(2_000 + 1_500)
        expect(result.outcome.status).toBe('timeout')
        expect(result.outcome).toMatchObject({ message: expect.stringMatching(/did not settle within 20ms .*timed out/) })
        expect(transport.closed).toBe(true)
    })

    it('surfaces a handler {error} envelope (rule 17) instead of calling it success', async () => {
        const transport = fakeTransport(() => ({ ok: true, result: encodeBase64(encrypt(key, 'dataKey', { error: 'handler exploded' })) }))
        const result = await resolvePermissionRequest(SID, REQ, { kind: 'approve' }, deps([pendingState], transport))
        expect(result.outcome).toEqual({ status: 'handler-error', message: 'handler exploded' })
    })

    it('settled=false when the request is still pending after the settle window', async () => {
        const transport = fakeTransport(() => ({ ok: true }))
        const result = await resolvePermissionRequest(SID, REQ, { kind: 'approve' }, deps([pendingState], transport))
        expect(result.outcome.status).toBe('acknowledged')
        expect(result.settled).toBe(false)
    })
})
