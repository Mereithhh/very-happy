import { describe, expect, it } from 'vitest';
import { DSH_CONTEXT_CAPABILITY, dshUsageUpdateOccupancy, readDshContextUsage } from './dshContext';

describe('B-970 dsh context usage', () => {
    it('reads used/size from an ACP usage_update', () => {
        expect(dshUsageUpdateOccupancy({ sessionUpdate: 'usage_update', used: 12_345, size: 1_000_000 })).toEqual({ tokens: 12_345, contextWindow: 1_000_000 });
        expect(dshUsageUpdateOccupancy({ used: 0, size: 128_000 })).toEqual({ tokens: 0, contextWindow: 128_000 });
    });

    it('refuses a payload dsh did not measure', () => {
        for (const bad of [null, undefined, 'x', {}, { used: 5 }, { size: 10 }, { used: -1, size: 10 }, { used: 5, size: 0 }, { used: Number.NaN, size: 10 }, { used: '5', size: 10 }]) {
            expect(dshUsageUpdateOccupancy(bad)).toBeNull();
        }
    });

    it('parses the agentState record, null when malformed', () => {
        const record = { sessionId: 's1', tokens: 10, contextWindow: 100, updatedAt: 1 };
        expect(readDshContextUsage(record)).toEqual(record);
        expect(readDshContextUsage({ ...record, tokens: -1 })).toBeNull();
        expect(readDshContextUsage({ ...record, sessionId: undefined })).toBeNull();
        expect(readDshContextUsage(undefined)).toBeNull();
        expect(DSH_CONTEXT_CAPABILITY).toBe('dsh-context-v1');
    });
});
