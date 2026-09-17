import { describe, expect, it, vi } from 'vitest';
import { ApiMachineClient } from './apiMachine';
import { ApiSessionClient } from './apiSession';
import { decodeBase64, decrypt } from './encryption';
import { CLIPBOARD_HISTORY_MAX_BYTES, CLIPBOARD_MAX_BYTES } from '@/clipboard/limits';

describe.each(['legacy', 'dataKey'] as const)('tool push history (%s encryption)', (variant) => {
    const key = new Uint8Array(32).fill(7);
    const plaintext = (value: string) => decrypt(key, variant, decodeBase64(value));

    for (const scope of ['machine', 'session'] as const) {
        it(`independently encrypts the ${scope} clipboard history with a smaller UTF-8 cap`, () => {
            const socket = { connected: true, emit: vi.fn() };
            const client = Object.assign(Object.create(scope === 'machine' ? ApiMachineClient.prototype : ApiSessionClient.prototype), {
                socket, encryptionKey: key, encryptionVariant: variant,
                machine: { encryptionKey: key, encryptionVariant: variant },
            });
            const text = '中'.repeat(CLIPBOARD_MAX_BYTES);
            expect(client.pushClipboard(text, 'term_1').delivered).toBe(true);
            const [event, payload] = socket.emit.mock.calls[0];
            expect(event).toBe('clipboard-push');
            expect(payload).toMatchObject({ enc: true, truncated: true, historyTruncated: true, totalBytes: Buffer.byteLength(text) });
            if (scope === 'machine') expect(payload.terminalId).toBe('term_1');
            else expect(payload.terminalId).toBeUndefined();
            const live = plaintext(payload.payload);
            const history = plaintext(payload.historyPayload);
            expect(Buffer.byteLength(live)).toBeLessThanOrEqual(CLIPBOARD_MAX_BYTES);
            expect(Buffer.byteLength(live)).toBeGreaterThan(CLIPBOARD_HISTORY_MAX_BYTES);
            expect(Buffer.byteLength(history)).toBeLessThanOrEqual(CLIPBOARD_HISTORY_MAX_BYTES);
            expect(history).not.toContain('�');
            expect(text.startsWith(history)).toBe(true);
            expect(payload.payload).not.toBe(payload.historyPayload);

            socket.emit.mockClear();
            client.pushClipboard('small');
            const small = socket.emit.mock.calls[0][1];
            expect(small.historyTruncated).toBe(false);
            expect(plaintext(small.historyPayload)).toBe('small');
            expect(small.historyPayload).not.toBe(small.payload);
            socket.emit.mockClear();
            client.pushClipboard('\0'.repeat(CLIPBOARD_HISTORY_MAX_BYTES));
            const escaped = socket.emit.mock.calls[0][1];
            expect(escaped.historyPayload.length).toBeLessThanOrEqual(48 * 1024);
            expect(escaped.historyTruncated).toBe(true);
            expect(plaintext(escaped.historyPayload)).toBe('\0'.repeat(Math.floor(CLIPBOARD_HISTORY_MAX_BYTES / 6)));
            socket.connected = false;
            socket.emit.mockClear();
            expect(client.pushClipboard('offline').delivered).toBe(false);
            expect(socket.emit).not.toHaveBeenCalled();
        });
    }

    it('routes machine previews to their terminal and refuses to report offline delivery', () => {
        const socket = { connected: true, emit: vi.fn() };
        const client = Object.assign(Object.create(ApiMachineClient.prototype), { socket, machine: { encryptionKey: key, encryptionVariant: variant } });
        expect(client.pushFilePreview('term_1', '/workspace/report.md', 'diff')).toEqual({ delivered: true });
        const [event, payload] = socket.emit.mock.calls[0];
        expect(event).toBe('file-preview-push');
        expect(payload).toMatchObject({ enc: true, terminalId: 'term_1', mode: 'diff' });
        expect(plaintext(payload.payload)).toBe('/workspace/report.md');
        socket.connected = false;
        socket.emit.mockClear();
        expect(client.pushFilePreview('term_1', '/workspace/report.md').delivered).toBe(false);
        expect(socket.emit).not.toHaveBeenCalled();
    });
});
