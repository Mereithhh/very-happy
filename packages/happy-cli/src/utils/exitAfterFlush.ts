/**
 * Exit only after stdout/stderr have handed everything to the OS.
 *
 * `process.exit()` does not wait for pending writes, and on POSIX a pipe or
 * socket stdout is asynchronous in Node: one write takes what fits in the
 * pipe's free space and libuv queues the rest for an event-loop turn that an
 * exit in the same tick never gets. `very-happy sessions list --json | …` was
 * cut at exactly the pipe capacity — 8 KiB on dev-sg, whose user is over
 * `fs.pipe-user-pages-soft` (new pipes get 2 pages), 64 KiB on a normal pipe,
 * ~150 KiB on the socketpair a Node parent hands its child — always with exit
 * code 0, while `> file` (synchronous on POSIX) was complete (2026-10-29).
 *
 * Why not `process.exitCode` + return: a one-shot command may still hold a
 * socket or timer (user-scoped socket, keep-alive agents, the logger), and a
 * CLI that hangs after printing is worse than the truncation. This keeps the
 * forced exit and only moves it behind the flush.
 *
 * A reader that never reads holds the exit back, as it holds back any process
 * that writes more than a pipe buffers; a reader that went away (EPIPE) ends
 * the wait.
 */

export type ExitCode = Parameters<typeof process.exit>[0]

/** The part of a Writable this needs (`process.stdout` / `process.stderr` in production). */
export interface FlushableStream {
    write(chunk: string, callback: (error?: Error | null) => void): boolean
    on(event: 'error', listener: (error: Error) => void): unknown
    readonly destroyed?: boolean
    readonly writableEnded?: boolean
}

/** Resolves once everything written to `stream` so far has left the process, or never can. */
export function flushStream(stream: FlushableStream): Promise<void> {
    return new Promise((resolve) => {
        if (stream.destroyed || stream.writableEnded) {
            resolve()
            return
        }
        // EPIPE and the like: stop waiting, and keep the error from turning into
        // an uncaught exception on the way out. Never removed — the destroy that
        // follows a failed write emits 'error' a tick after the callback below.
        stream.on('error', () => resolve())
        try {
            // Write callbacks run in order: this one fires after every earlier
            // write has been handed to the OS.
            stream.write('', () => resolve())
        } catch {
            resolve()
        }
    })
}

/** Flush every stream, then `exit(code)`. */
export async function flushThenExit(code: ExitCode, streams: readonly FlushableStream[], exit: (code: ExitCode) => never): Promise<never> {
    await Promise.all(streams.map(flushStream))
    return exit(code)
}

/** Use instead of `process.exit(code)` after printing a command's output: `return exitAfterFlush(code)`. */
export function exitAfterFlush(code: ExitCode): Promise<never> {
    return flushThenExit(code, [process.stdout, process.stderr], (exitCode) => process.exit(exitCode))
}
