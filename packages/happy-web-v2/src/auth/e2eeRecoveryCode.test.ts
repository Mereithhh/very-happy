import { describe, expect, it } from 'vitest';
import { decodeE2eeRecoveryCode, encodeE2eeRecoveryCode } from './e2eeRecoveryCode';

const RRK = Uint8Array.from({ length: 32 }, (_, index) => index);
const VECTOR = 'VH1-AAAS-EA2E-AWDA-QCAK-BJFS-2DJQ-B6JB-CESV-CSLT-NF22-DEPB-YHA7-D2RY-K6YK-UJ';

describe('E2EE recovery code', () => {
    it('matches the frozen checksum/base32 vector', async () => {
        await expect(encodeE2eeRecoveryCode(RRK)).resolves.toBe(VECTOR);
        await expect(decodeE2eeRecoveryCode(VECTOR)).resolves.toEqual(RRK);
    });

    it('rejects corrections, non-canonical formatting, and checksum damage', async () => {
        await expect(decodeE2eeRecoveryCode(VECTOR.toLowerCase())).rejects.toThrow(/exact VH1/);
        const ambiguous = 'VH1-CNKT-GE2V-CNKT-GE2V-CNKT-GE2V-CNKT-GE2V-CNKT-GE2V-CNKT-GE2V-CNK9-459K-96';
        await expect(decodeE2eeRecoveryCode(ambiguous.replace('G', '9'))).rejects.toThrow(/checksum/);
        await expect(decodeE2eeRecoveryCode(ambiguous.replace('9', 'G'))).rejects.toThrow(/checksum/);
        await expect(decodeE2eeRecoveryCode(VECTOR.replace('A', 'O'))).rejects.toThrow(/exact VH1/);
        await expect(decodeE2eeRecoveryCode(VECTOR.replace('-', ''))).rejects.toThrow(/exact VH1/);
    });
});
