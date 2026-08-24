import { describe, expect, it } from 'vitest';
import { decodePrismaBytes } from './prismaBytes';

describe('decodePrismaBytes', () => {
    it('keeps database byte inputs as Buffers for Prisma PostgreSQL adapters', () => {
        const value = decodePrismaBytes(Buffer.from([0, 1, 127, 128, 255]).toString('base64'));

        expect(Buffer.isBuffer(value)).toBe(true);
        expect(Array.from(value)).toEqual([0, 1, 127, 128, 255]);
    });

    it.each(['not-base64!', '%%', 'a', 'AAAA='])('rejects malformed base64 instead of writing corrupted bytes: %s', (value) => {
        expect(() => decodePrismaBytes(value)).toThrow();
    });
});
