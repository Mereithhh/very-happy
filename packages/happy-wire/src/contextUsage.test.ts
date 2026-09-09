import { describe, it, expect } from 'vitest';
import { ContextUsageSchema } from './contextUsage';
describe('context occupancy snapshot', () => {
    it('keeps unknown distinct from zero and accepts custom model capacities', () => {
        const snapshot = {source:'pi',tokens:null,contextWindow:131072,updatedAt:1};
        expect(ContextUsageSchema.parse(snapshot).tokens).toBeNull();
        expect(ContextUsageSchema.parse({...snapshot,tokens:0}).tokens).toBe(0);
        expect(ContextUsageSchema.safeParse({...snapshot,tokens:Infinity}).success).toBe(false);
        expect(ContextUsageSchema.safeParse({...snapshot,contextWindow:0}).success).toBe(false);
    });
});
