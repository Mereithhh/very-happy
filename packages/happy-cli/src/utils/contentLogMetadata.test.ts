import { describe, expect, it } from 'vitest';
import { contentLogMetadata, errorLogMetadata } from './contentLogMetadata';

describe('content log metadata', () => {
    it('reports UTF-8 size without retaining text', () => {
        const secret = 'token=super-secret 🚀';
        const metadata = contentLogMetadata(secret);

        expect(metadata).toEqual({
            valueType: 'string',
            valueBytes: Buffer.byteLength(secret, 'utf8'),
        });
        expect(JSON.stringify(metadata)).not.toContain(secret);
        expect(JSON.stringify(metadata)).not.toContain('super-secret');
    });

    it('reports collection shape without retaining keys or values', () => {
        const metadata = contentLogMetadata({ privatePrompt: 'do not log me' });

        expect(metadata).toEqual({
            valueType: 'object',
            keyCount: 1,
            payloadBytes: Buffer.byteLength(JSON.stringify({ privatePrompt: 'do not log me' }), 'utf8'),
        });
        expect(JSON.stringify(metadata)).not.toContain('privatePrompt');
        expect(JSON.stringify(metadata)).not.toContain('do not log me');
    });

    it('does not retain error messages', () => {
        const error = Object.assign(new Error('password=do-not-log'), { code: 'EACCES' });
        const metadata = errorLogMetadata(error);

        expect(metadata).toEqual({ errorType: 'Error', errorCode: 'EACCES' });
        expect(JSON.stringify(metadata)).not.toContain('do-not-log');
    });
});
