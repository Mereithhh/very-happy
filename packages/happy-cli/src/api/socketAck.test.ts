import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerSocketRequest, safeAck, describeSocketAckDrop, type SocketAckDrop } from './socketAck';

/**
 * B-477 regression: on 2026-09-19 a `rpc-request` frame redelivered after a
 * transport close arrived without an ack callback. `callback(await …)` threw
 * `TypeError: callback is not a function` inside an async listener, the
 * unhandled rejection was treated as fatal, and the daemon exited.
 *
 * The load-bearing property is that answering is best-effort: whatever the ack
 * or the handler does, nothing escapes the listener.
 */
describe('answerSocketRequest', () => {
    it('delivers the handler result through the ack', async () => {
        const ack = vi.fn();
        const onDrop = vi.fn();
        await answerSocketRequest<string>(ack, async () => 'payload', onDrop);
        expect(ack).toHaveBeenCalledWith('payload');
        expect(onDrop).not.toHaveBeenCalled();
    });

    it('does not reject when the frame carries no ack (the 2026-09-19 crash)', async () => {
        const onDrop = vi.fn();
        const run = vi.fn(async () => 'payload');
        await expect(answerSocketRequest<string>(undefined, run, onDrop)).resolves.toBeUndefined();
        expect(run).toHaveBeenCalledTimes(1);
        expect(onDrop).toHaveBeenCalledWith({ reason: 'no-ack' });
    });

    it.each([
        ['null', null],
        ['a non-function value', 'not-a-callback'],
    ])('reports %s as a dropped response instead of throwing', async (_label, ack) => {
        const onDrop = vi.fn();
        await expect(answerSocketRequest<string>(ack, async () => 'payload', onDrop)).resolves.toBeUndefined();
        expect(onDrop).toHaveBeenCalledWith({ reason: 'no-ack' });
    });

    it('swallows a rejecting handler and never calls the ack', async () => {
        const ack = vi.fn();
        const onDrop = vi.fn();
        const failure = new Error('handler blew up');
        await expect(answerSocketRequest<string>(ack, async () => { throw failure; }, onDrop)).resolves.toBeUndefined();
        expect(ack).not.toHaveBeenCalled();
        expect(onDrop).toHaveBeenCalledWith({ reason: 'handler-threw', error: failure });
    });

    it('swallows a throwing ack', async () => {
        const failure = new Error('ack blew up');
        const ack = vi.fn(() => { throw failure; });
        const onDrop = vi.fn();
        await expect(answerSocketRequest<string>(ack, async () => 'payload', onDrop)).resolves.toBeUndefined();
        expect(onDrop).toHaveBeenCalledWith({ reason: 'ack-threw', error: failure });
    });

    it('leaves no unhandled rejection behind when the ack is missing', async () => {
        const seen: unknown[] = [];
        const onUnhandled = (reason: unknown) => { seen.push(reason); };
        process.on('unhandledRejection', onUnhandled);
        try {
            await answerSocketRequest<string>(undefined, async () => 'payload', () => { });
            await new Promise(resolve => setTimeout(resolve, 10));
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
        expect(seen).toEqual([]);
    });
});

describe('safeAck', () => {
    it('forwards the value when the ack is callable', () => {
        const ack = vi.fn();
        safeAck<{ ok: boolean }>(ack, () => { })({ ok: true });
        expect(ack).toHaveBeenCalledWith({ ok: true });
    });

    it('is callable from every branch without a callback present', () => {
        const drops: SocketAckDrop[] = [];
        const answer = safeAck<{ ok: boolean }>(undefined, drop => drops.push(drop));
        expect(() => { answer({ ok: false }); answer({ ok: true }); }).not.toThrow();
        expect(drops).toEqual([{ reason: 'no-ack' }, { reason: 'no-ack' }]);
    });
});

describe('describeSocketAckDrop', () => {
    it('names the error for the two throwing cases', () => {
        expect(describeSocketAckDrop({ reason: 'handler-threw', error: new Error('boom') })).toContain('boom');
        expect(describeSocketAckDrop({ reason: 'ack-threw', error: new Error('bang') })).toContain('bang');
        expect(describeSocketAckDrop({ reason: 'no-ack' })).toContain('no ack callback');
    });
});

/**
 * Wiring: the listeners that crashed must answer through the helper. Asserting
 * the call shape (not just the helper name) so that reverting any one site to
 * `callback(await …)` turns this red.
 */
describe('socket listeners answer through answerSocketRequest', () => {
    const read = (file: string) => readFileSync(join(__dirname, file), 'utf-8');

    it('apiMachine rpc-request passes the optional callback to the helper', () => {
        const source = read('apiMachine.ts');
        expect(source).toContain('callback?: (response: string) => void');
        expect(source).toContain('await answerSocketRequest<string>(\n                callback,');
        expect(source).toContain('[API MACHINE] RPC ${data?.method} via ${transport} unanswered');
        expect(source).not.toContain('callback(await this.rpcHandlerManager.handleRequest(data));');
    });

    it('apiSession answers its control socket rpc-request through the helper', () => {
        const source = read('apiSession.ts');
        expect(source).toContain('[API] RPC ${data?.method} unanswered');
        expect(source).not.toContain('callback(await this.rpcHandlerManager.handleRequest(data));');
    });

    it('apiSession answers its relay socket rpc-request through the helper', () => {
        const source = read('apiSession.ts');
        expect(source).toContain('[API] Relay RPC ${data?.method} unanswered');
    });

    it('apiSession session-message-deliver answers through safeAck', () => {
        const source = read('apiSession.ts');
        expect(source).toContain('rawCallback?: (response: unknown) => void');
        expect(source).toContain('const callback = safeAck<unknown>(rawCallback,');
    });
});
