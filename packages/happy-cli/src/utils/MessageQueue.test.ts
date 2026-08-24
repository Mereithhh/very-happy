import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ debug: vi.fn() }));
vi.mock('@/ui/logger', () => ({ logger: { debug: mocks.debug } }));

import { MessageQueue } from './MessageQueue';

describe('MessageQueue safe diagnostics', () => {
    beforeEach(() => mocks.debug.mockClear());

    it('logs message length but never queued user text', () => {
        const secret = 'private customer prompt 你好';
        const queue = new MessageQueue();
        queue.push(secret);
        const output = JSON.stringify(mocks.debug.mock.calls);
        expect(output).toContain(`bytes=${Buffer.byteLength(secret, 'utf8')}`);
        expect(output).not.toContain(secret);
    });

    it('does not expose user text when delivering directly to a waiter', async () => {
        const secret = 'second private prompt';
        const queue = new MessageQueue();
        const iterator = queue[Symbol.asyncIterator]();
        const pending = iterator.next();
        await Promise.resolve();
        queue.push(secret);
        expect((await pending).value?.message.content).toBe(secret);
        const output = JSON.stringify(mocks.debug.mock.calls);
        expect(output).toContain(`bytes=${Buffer.byteLength(secret, 'utf8')}`);
        expect(output).not.toContain(secret);
        queue.close();
    });
});
