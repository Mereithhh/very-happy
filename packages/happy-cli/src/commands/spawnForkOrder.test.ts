/**
 * B-531 mechanism regression: `very-happy spawn --fork <id> --prompt …` put
 * the prompt in the MIDDLE of the replayed history (dev-sg 2026-10-04,
 * session cmut7a4h…: 95 replay lines queued at 10:27:09.549, the CLI's prompt
 * reached the server at .690 while the replay was still uploading).
 *
 * The wrapper side here is the REAL ApiSessionClient outbox (socket and HTTP
 * mocked) plus the real publishForkBackfillWhenCommitted; the CLI side is the
 * real spawn `sendFirstMessage`. A fake server allocates seq when a POST is
 * processed, after a per-request transit delay — the same shape as
 * production, where a 50-message batch takes longer than one small prompt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIo, mockAxiosPost, mockAxiosGet } = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockAxiosPost: vi.fn(),
    mockAxiosGet: vi.fn(),
}))

vi.mock('socket.io-client', () => ({ io: mockIo }))
vi.mock('axios', () => ({ default: { get: mockAxiosGet, post: mockAxiosPost } }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn()
        onSocketConnectAndWait = vi.fn(async () => undefined)
        onSocketDisconnect = vi.fn()
        handleRequest = vi.fn(async () => '')
    },
}))
vi.mock('@/modules/common/registerCommonHandlers', () => ({ registerCommonHandlers: vi.fn() }))
vi.mock('@/utils/lidState', () => ({ shouldReconnect: () => true }))

import { ApiSessionClient } from '@/api/apiSession'
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption'
import type { PersistedSession } from '@/persistence'
import { FORK_BACKFILL_CAPABILITY, ForkBackfillTimeoutError, publishForkBackfillWhenCommitted } from '@/utils/forkBackfill'
import { sendFirstMessage, type FirstMessageDeps } from './spawn'

const KEY = new Uint8Array(32)
const HISTORY = 95 // the incident's replay size
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

let sessionCounter = 0

class FakeServer {
    /** Unique per test: a client left over from an earlier (failed) test cannot write into this log. */
    readonly sessionId = `forked-session-${++sessionCounter}`
    private seq = 0
    readonly log: Array<{ seq: number; tag: string }> = []
    metadata: Record<string, unknown> = { path: '/repo' }
    metadataVersion = 0
    /** Transit time of a wrapper outbox POST (a 50-message batch) before the server processes it. */
    batchDelayMs = 15
    /** Set to hold every wrapper POST forever (upload never confirmed). */
    stallWrapperPosts = false

    commit(tags: string[]): number[] {
        return tags.map((tag) => {
            this.seq += 1
            this.log.push({ seq: this.seq, tag })
            return this.seq
        })
    }

    seqOf(tag: string): number | undefined {
        return this.log.find((entry) => entry.tag === tag)?.seq
    }

    historySeqs(): number[] {
        return this.log.filter((entry) => entry.tag.startsWith('h')).map((entry) => entry.seq)
    }
}

let server: FakeServer

function makeWrapperClient(): ApiSessionClient {
    const socket = {
        connected: true,
        connect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn(),
        volatile: { emit: vi.fn() },
        close: vi.fn(),
        emitWithAck: vi.fn(async (event: string, payload: { expectedVersion: number; metadata: string }) => {
            if (event !== 'update-metadata') return { result: 'error' }
            if (payload.expectedVersion !== server.metadataVersion) {
                return { result: 'version-mismatch', version: server.metadataVersion, metadata: encodeBase64(encrypt(KEY, 'legacy', server.metadata)) }
            }
            server.metadata = decrypt(KEY, 'legacy', decodeBase64(payload.metadata))
            server.metadataVersion += 1
            return { result: 'success', version: server.metadataVersion, metadata: payload.metadata }
        }),
    }
    mockIo.mockReturnValue(socket)
    return new ApiSessionClient('token', {
        id: server.sessionId,
        seq: 0,
        metadata: { path: '/repo', host: 'h', homeDir: '/h', happyHomeDir: '/h/.happy', happyLibDir: '/l', happyToolsDir: '/t' },
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        encryptionKey: KEY,
        encryptionVariant: 'legacy',
    })
}

/** What runClaude / runCodex do on a fork: queue the replay, then publish the marker off the startup path. */
function wrapperReplaysHistory(client: ApiSessionClient): void {
    for (let i = 0; i < HISTORY; i += 1) client.sendCodexMessage({ tag: `h${i}` })
    void publishForkBackfillWhenCommitted(client, { count: HISTORY })
}

function cliDeps(capabilities: string[], warn = vi.fn()): FirstMessageDeps {
    const persisted = { encryptionKey: encodeBase64(KEY), encryptionVariant: 'legacy', metadata: { path: '/repo', capabilities } } as unknown as PersistedSession
    return {
        waitForSessionKey: async () => persisted,
        readSessionMetadata: async () => {
            await sleep(1)
            return server.metadata
        },
        // The CLI's prompt is one small POST: processed right away.
        sendUserMessage: async () => {
            await sleep(1)
            server.commit(['prompt'])
        },
        forkWait: { pollMs: 5, timeoutMs: 3_000 },
        warn,
    }
}

const metaFor = () => ({ permissionMode: 'yolo' })

describe('B-531 fork first message lands after the replayed history', () => {
    beforeEach(() => {
        server = new FakeServer()
        mockAxiosGet.mockResolvedValue({ data: { messages: [], hasMore: false } })
        mockAxiosPost.mockImplementation(async (url: string, body: { messages: Array<{ content: string; localId: string }> }) => {
            if (!url.endsWith(`/v3/sessions/${server.sessionId}/messages`)) return { data: { messages: [] } }
            if (server.stallWrapperPosts) await new Promise(() => undefined)
            await sleep(server.batchDelayMs)
            const tags = body.messages.map((message) => {
                const content = decrypt(KEY, 'legacy', decodeBase64(message.content)) as { content: { data: { tag: string } } }
                return content.content.data.tag
            })
            const seqs = server.commit(tags)
            return { data: { messages: body.messages.map((message, i) => ({ id: `m${seqs[i]}`, seq: seqs[i], localId: message.localId, createdAt: 0, updatedAt: 0 })) } }
        })
    })

    afterEach(() => {
        vi.clearAllMocks()
    })

    it('reproduces the incident without the gate: an immediate send lands inside the replay', async () => {
        const client = makeWrapperClient()
        wrapperReplaysHistory(client)
        // Pre-fix behaviour = sending without waiting (what a non-fork send does).
        await sendFirstMessage(server.sessionId, 'continue', metaFor, { fork: false }, cliDeps([FORK_BACKFILL_CAPABILITY]))
        await client.drainOutbox()
        const prompt = server.seqOf('prompt')!
        expect(server.historySeqs()).toHaveLength(HISTORY)
        expect(prompt).toBeLessThan(Math.max(...server.historySeqs()))
        await client.close()
    })

    it('a fork waits for the committed replay: the prompt gets a seq after every history message', async () => {
        const client = makeWrapperClient()
        wrapperReplaysHistory(client)
        await sendFirstMessage(server.sessionId, 'continue', metaFor, { fork: true }, cliDeps([FORK_BACKFILL_CAPABILITY]))
        const prompt = server.seqOf('prompt')!
        expect(server.historySeqs()).toHaveLength(HISTORY)
        expect(prompt).toBeGreaterThan(Math.max(...server.historySeqs()))
        expect(server.metadata.forkBackfill).toMatchObject({ done: true, count: HISTORY })
        await client.close()
    })

    it('a capable wrapper whose upload never confirms: timeout error, prompt NOT sent', async () => {
        server.stallWrapperPosts = true
        const client = makeWrapperClient()
        wrapperReplaysHistory(client)
        const deps = cliDeps([FORK_BACKFILL_CAPABILITY])
        deps.forkWait = { pollMs: 5, timeoutMs: 100 }
        await expect(sendFirstMessage(server.sessionId, 'continue', metaFor, { fork: true }, deps)).rejects.toBeInstanceOf(ForkBackfillTimeoutError)
        expect(server.seqOf('prompt')).toBeUndefined()
        expect(server.metadata.forkBackfill).toBeUndefined()
        await client.close()
    })

    it('an old wrapper (no capability) is not waited for: immediate send + warning, no hang', async () => {
        const client = makeWrapperClient()
        for (let i = 0; i < HISTORY; i += 1) client.sendCodexMessage({ tag: `h${i}` }) // old wrapper: no marker
        const warn = vi.fn()
        const started = Date.now()
        await sendFirstMessage(server.sessionId, 'continue', metaFor, { fork: true }, cliDeps(['claude-steer-v1'], warn))
        expect(Date.now() - started).toBeLessThan(1_000)
        expect(server.seqOf('prompt')).toBeDefined()
        expect(warn).toHaveBeenCalledTimes(1)
        await client.drainOutbox()
        await client.close()
    })

    it('a non-fork spawn never reads metadata (unchanged, no extra latency)', async () => {
        const deps = cliDeps([FORK_BACKFILL_CAPABILITY])
        const readSessionMetadata = vi.fn(deps.readSessionMetadata)
        await sendFirstMessage(server.sessionId, 'hi', metaFor, { fork: false }, { ...deps, readSessionMetadata })
        expect(readSessionMetadata).not.toHaveBeenCalled()
        expect(server.seqOf('prompt')).toBe(1)
    })
})

describe('B-531 ApiSessionClient.drainOutbox', () => {
    beforeEach(() => {
        server = new FakeServer()
    })

    it('resolves only after the server answered every message queued before the call', async () => {
        const releases: Array<() => void> = []
        mockAxiosPost.mockImplementation((_url: string, body: { messages: Array<{ localId: string }> }) => new Promise((resolve) => {
            releases.push(() => resolve({ data: { messages: body.messages.map((m, i) => ({ id: `m${i}`, seq: i + 1, localId: m.localId, createdAt: 0, updatedAt: 0 })) } }))
        }))
        const client = makeWrapperClient()
        client.sendCodexMessage({ tag: 'h0' })
        let drained: boolean | null = null
        void client.drainOutbox().then((value) => { drained = value })
        await sleep(10)
        expect(drained).toBeNull()
        releases.shift()!()
        await sleep(10)
        expect(drained).toBe(true)
        await client.close()
    })

    it('returns false when the client closes before the server answered', async () => {
        mockAxiosPost.mockImplementation(() => new Promise(() => undefined))
        const client = makeWrapperClient()
        client.sendCodexMessage({ tag: 'h0' })
        const drained = client.drainOutbox()
        await sleep(5)
        await client.close()
        await expect(drained).resolves.toBe(false)
    })
})
