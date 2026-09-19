/**
 * B-477 — a socket.io ack callback is optional, and assuming it exists killed
 * the daemon.
 *
 * socket.io only hands the listener an ack callback when the emitter used
 * `emitWithAck`. A frame that is re-delivered after a transport close — a relay
 * switch, a reconnect, the server retrying — can arrive without one. The
 * `rpc-request` listeners were written as `callback(await handleRequest(data))`,
 * so in that case the listener threw `TypeError: callback is not a function`
 * from inside an async function: an unhandled rejection, which `daemon/run.ts`
 * treats as fatal. One dropped ack took the whole machine offline.
 *
 * 2026-09-19 on mac-office: a 3.6MB `open-terminal` response, a `transport
 * close` in the same second, a relay re-select, and the re-delivered frame had
 * no ack. The daemon shut down and stayed down for 25 hours (see
 * `daemonExitCode` in `daemon/shutdownExit.ts` for the half that kept it down).
 *
 * The rule these helpers encode: answering a request is best-effort. A missing
 * or throwing ack, or a handler that rejects, is a dropped response and a log
 * line — never an exception that escapes the listener.
 */

export type SocketAckDrop =
    | { reason: 'no-ack' }
    | { reason: 'handler-threw'; error: unknown }
    | { reason: 'ack-threw'; error: unknown };

export function describeSocketAckDrop(drop: SocketAckDrop): string {
    switch (drop.reason) {
        case 'no-ack':
            return 'no ack callback on the frame (re-delivered after a transport close?); response dropped';
        case 'handler-threw':
            return `handler threw: ${drop.error instanceof Error ? drop.error.message : String(drop.error)}`;
        case 'ack-threw':
            return `ack callback threw: ${drop.error instanceof Error ? drop.error.message : String(drop.error)}`;
    }
}

/**
 * Wrap a possibly-absent ack in a function that is always safe to call.
 * Use this for listeners that answer from several branches.
 */
export function safeAck<T>(ack: unknown, onDrop: (drop: SocketAckDrop) => void): (value: T) => void {
    return (value: T) => {
        if (typeof ack !== 'function') {
            onDrop({ reason: 'no-ack' });
            return;
        }
        try {
            (ack as (value: T) => void)(value);
        } catch (error) {
            onDrop({ reason: 'ack-threw', error });
        }
    };
}

/**
 * The `callback(await handler(data))` shape, made non-fatal. Never rejects.
 */
export async function answerSocketRequest<T>(
    ack: unknown,
    run: () => Promise<T>,
    onDrop: (drop: SocketAckDrop) => void,
): Promise<void> {
    let value: T;
    try {
        value = await run();
    } catch (error) {
        onDrop({ reason: 'handler-threw', error });
        return;
    }
    safeAck<T>(ack, onDrop)(value);
}
