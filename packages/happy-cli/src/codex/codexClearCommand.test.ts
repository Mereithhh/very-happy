import { describe, expect, it, vi } from 'vitest';

import { enqueueCodexUserText } from './codexClearCommand';

describe('enqueueCodexUserText', () => {
    it('queues /clear in isolation instead of batching it into a model prompt', () => {
        const mode = { permissionMode: 'default' as const };
        const queue = {
            push: vi.fn(),
            pushIsolateAndClear: vi.fn(),
        };

        const result = enqueueCodexUserText({
            text: '  /clear  ',
            mode,
            queue,
            sourceId: 'web-local-1',
        });

        expect(result).toBe('clear');
        // B-332: the web's localId rides along so a destroyed item can be tombstoned.
        expect(queue.pushIsolateAndClear).toHaveBeenCalledWith('  /clear  ', mode, undefined, 'web-local-1');
        expect(queue.push).not.toHaveBeenCalled();
    });

    it('threads the source id through ordinary pushes too (B-332)', () => {
        const mode = { permissionMode: 'default' as const };
        const queue = { push: vi.fn(), pushIsolateAndClear: vi.fn() };
        expect(enqueueCodexUserText({ text: 'hello', mode, queue, sourceId: 'web-local-2' })).toBe('queued');
        expect(queue.push).toHaveBeenCalledWith('hello', mode, undefined, 'web-local-2');
    });
});

it('keeps attachment ownership and source id on the queued message', () => {
    const attachments = [{ data: new Uint8Array([1, 2]), mimeType: 'image/png', name: 'a.png' }];
    const queue = { push: vi.fn(), pushIsolateAndClear: vi.fn() };
    enqueueCodexUserText({ text: '', mode: 'default', queue, attachments, sourceId: 'image-only' });
    expect(queue.push).toHaveBeenCalledWith('', 'default', attachments, 'image-only');
});
