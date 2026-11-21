/**
 * B-951: `very-happy spawn` failed its first message on a single 503 (R69 QA:
 * "Session spawned but first message failed: Request failed with status code
 * 503"). Transient failures are retried, bounded, with backoff and one localId;
 * a permanent 4xx still fails at once.
 */
import { describe, expect, it, vi } from 'vitest'
import { sendFirstMessage, type FirstMessageDeps } from './spawn'

const httpError = (status: number) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } })

function deps(failures: unknown[]) {
    const sleeps: number[] = []
    const warn = vi.fn()
    const sendUserMessage = vi.fn(async () => {
        const failure = failures.shift()
        if (failure) throw failure
    })
    const d: FirstMessageDeps = {
        waitForSessionKey: vi.fn(async () => ({ encryptionKey: 'k', encryptionVariant: 'legacy', metadata: {} }) as any),
        readSessionMetadata: vi.fn(async () => ({})),
        sendUserMessage: sendUserMessage as any,
        warn,
        sendRetry: { sleep: async (ms) => { sleeps.push(ms) } },
    }
    return { d, sleeps, warn, sendUserMessage }
}

const send = (d: FirstMessageDeps) => sendFirstMessage('s1', 'hello', () => ({ model: 'm' }) as any, { fork: false }, d)

describe('B-951: the first message of a spawn survives a transient server failure', () => {
    it.each([
        ['a 503', httpError(503)],
        ['a 502', httpError(502)],
        ['a 429', httpError(429)],
        ['no answer at all', new Error('socket hang up')],
    ])('%s is retried with backoff and the same localId', async (_label, error) => {
        const { d, sleeps, warn, sendUserMessage } = deps([error, error])
        await expect(send(d)).resolves.toEqual({ model: 'm' })
        expect(sendUserMessage).toHaveBeenCalledTimes(3)
        const localIds = sendUserMessage.mock.calls.map((call: any[]) => call[4].localId)
        expect(new Set(localIds).size).toBe(1)
        expect(localIds[0]).toMatch(/^[0-9a-f-]{36}$/)
        expect(sendUserMessage.mock.calls[0][4]).toMatchObject({ model: 'm' })
        expect(sleeps).toEqual([1_000, 2_000])
        expect(warn).toHaveBeenCalledTimes(2)
        expect(warn.mock.calls[0][0]).toMatch(/retrying in 1s \(1\/3\)/)
    })

    it('gives up after a bounded number of attempts, saying so', async () => {
        const { d, sleeps, sendUserMessage } = deps(Array.from({ length: 10 }, () => httpError(503)))
        await expect(send(d)).rejects.toThrow('HTTP 503, still failing after 4 attempts')
        expect(sendUserMessage).toHaveBeenCalledTimes(4)
        expect(sleeps).toEqual([1_000, 2_000, 4_000])
    })

    it.each([400, 401, 403, 404, 413])('a permanent %i fails at once', async (status) => {
        const { d, sleeps, sendUserMessage } = deps([httpError(status)])
        await expect(send(d)).rejects.toThrow(`the server refused it (HTTP ${status})`)
        expect(sendUserMessage).toHaveBeenCalledTimes(1)
        expect(sleeps).toEqual([])
    })
})
