import { describe, expect, it } from 'vitest';
import { safeErrorMetadata, sanitizeLogText, sanitizeLogValue, stableLogRef } from './logSafety';

describe('safe server logging', () => {
    it('pseudonymizes identifiers consistently without retaining the raw value', () => {
        const first = stableLogRef('session', 'session-secret-123');
        expect(first).toBe(stableLogRef('session', 'session-secret-123'));
        expect(first).not.toContain('session-secret-123');
        expect(first).not.toBe(stableLogRef('machine', 'session-secret-123'));
    });

    it('keeps only bounded error categories, never message, stack, cause, or paths', () => {
        const error = Object.assign(new Error('postgres at /private/data?token=secret'), {
            code: 'P2002',
            statusCode: 503,
            cause: new Error('nested secret'),
        });
        expect(safeErrorMetadata(error)).toEqual({ errorType: 'Error', code: 'P2002', status: 503 });
        expect(JSON.stringify(safeErrorMetadata(error))).not.toContain('private');
        expect(JSON.stringify(safeErrorMetadata(error))).not.toContain('secret');
    });

    it('redacts structured secrets/content and hashes linkable ids', () => {
        const safe = sanitizeLogValue({
            module: 'websocket',
            userId: 'user-raw',
            sessionId: 'session-raw',
            token: 'bearer-secret',
            payload: 'private transcript',
            status: 429,
            error: Object.assign(new Error('provider response body'), { code: 'UPSTREAM' }),
        });
        const serialized = JSON.stringify(safe);
        expect(serialized).toContain('websocket');
        expect(serialized).toContain('UPSTREAM');
        expect(serialized).toContain('429');
        expect(serialized).not.toContain('user-raw');
        expect(serialized).not.toContain('session-raw');
        expect(serialized).not.toContain('bearer-secret');
        expect(serialized).not.toContain('private transcript');
        expect(serialized).not.toContain('provider response body');
    });

    it('scrubs common credentials, URLs, email addresses, control characters, and long text', () => {
        const safe = sanitizeLogText(`Bearer super-secret\nhttps://private.example/x?a=1 owner@example.com ${'x'.repeat(4_000)}`);
        expect(safe).not.toContain('super-secret');
        expect(safe).not.toContain('private.example');
        expect(safe).not.toContain('owner@example.com');
        expect(safe).not.toContain('\n');
        expect(Buffer.byteLength(safe, 'utf8')).toBeLessThanOrEqual(2_048);
    });

    it('handles cyclic structured values without throwing', () => {
        const value: Record<string, unknown> = { module: 'test' };
        value.self = value;
        expect(sanitizeLogValue(value)).toEqual({ module: 'test', self: '[circular]' });
    });
});
