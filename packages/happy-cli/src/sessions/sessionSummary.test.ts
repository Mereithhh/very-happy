import { describe, expect, it } from 'vitest';
import { encodeBase64, encrypt, getRandomBytes } from '@/api/encryption';
import { sessionSummaryFromRow } from './sessionOps';

describe('B-974h P3-10 sessionSummaryFromRow: live title and update time from GET /v1/sessions/:id', () => {
    const key = getRandomBytes(32);
    const persisted = { encryptionKey: encodeBase64(key), encryptionVariant: 'dataKey' as const };
    const meta = (m: unknown) => encodeBase64(encrypt(key, 'dataKey', m));

    it('decrypts summary.text (then name) and takes updatedAt (then activeAt)', () => {
        expect(sessionSummaryFromRow({ id: 's', updatedAt: 1_800_000_000_000, metadata: meta({ summary: { text: ' Fix login ', updatedAt: 1 }, name: 'n' }) }, persisted))
            .toEqual({ title: 'Fix login', updatedAt: 1_800_000_000_000 });
        expect(sessionSummaryFromRow({ id: 's', activeAt: 7, metadata: meta({ name: 'named' }) }, persisted)).toEqual({ title: 'named', updatedAt: 7 });
    });

    it('leaves fields out when unknown or undecryptable', () => {
        expect(sessionSummaryFromRow({ id: 's', updatedAt: 0, metadata: meta({ path: '/x' }) }, persisted)).toEqual({});
        expect(sessionSummaryFromRow({ id: 's', metadata: 'bm90LWNpcGhlcnRleHQ=' }, persisted)).toEqual({});
        expect(sessionSummaryFromRow(null, persisted)).toBeNull();
    });
});
