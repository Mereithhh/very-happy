import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { flushStream, flushThenExit, type ExitCode } from './exitAfterFlush'

/**
 * A Writable whose non-empty writes complete only when the test says so: a
 * pipe whose reader has not caught up. `release()` completes them, or fails
 * them (EPIPE: the reader went away).
 */
function slowPipe() {
    const pending: Array<(error?: Error | null) => void> = []
    const stream = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            if (chunk.length === 0) callback()
            else pending.push(callback)
        },
    })
    return {
        stream,
        release(error?: Error) {
            for (const done of pending.splice(0)) done(error)
        },
    }
}

const later = () => new Promise((resolve) => setTimeout(resolve, 10))
const exitSpy = () => vi.fn<(code: ExitCode) => never>()

describe('flushThenExit (2026-10-29: piped --json cut at the pipe capacity)', () => {
    it('exits only after a write still queued at call time has completed', async () => {
        const pipe = slowPipe()
        const exit = exitSpy()
        pipe.stream.write('x'.repeat(1 << 20))
        const exiting = flushThenExit(0, [pipe.stream], exit)
        await later()
        expect(exit).not.toHaveBeenCalled()
        pipe.release()
        await exiting
        expect(exit).toHaveBeenCalledWith(0)
    })

    it('waits for every stream (stdout and stderr) and keeps the exit code', async () => {
        const out = slowPipe()
        const err = slowPipe()
        const exit = exitSpy()
        out.stream.write('{"sessions":[]}\n')
        err.stream.write('Timeout: the latest turn did not end\n')
        const exiting = flushThenExit(2, [out.stream, err.stream], exit)
        out.release()
        await later()
        expect(exit).not.toHaveBeenCalled()
        err.release()
        await exiting
        expect(exit).toHaveBeenCalledWith(2)
    })

    it('a reader that went away (EPIPE) ends the wait, and the error is not left uncaught', async () => {
        const pipe = slowPipe()
        const exit = exitSpy()
        pipe.stream.write('x'.repeat(1 << 20))
        const exiting = flushThenExit(0, [pipe.stream], exit)
        pipe.release(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
        await exiting
        // The failed write destroys the stream, which emits 'error' a tick
        // later; without a listener that is an uncaught exception (the run fails).
        await later()
        expect(pipe.stream.destroyed).toBe(true)
        expect(exit).toHaveBeenCalledWith(0)
    })
})

describe('flushStream', () => {
    it('does not wait on a stream that can no longer be written', async () => {
        const ended = new Writable({ write: (_chunk, _encoding, callback) => callback() })
        ended.end()
        const destroyed = new Writable({ write: (_chunk, _encoding, callback) => callback() })
        destroyed.destroy()
        await expect(flushStream(ended)).resolves.toBeUndefined()
        await expect(flushStream(destroyed)).resolves.toBeUndefined()
    })
})
