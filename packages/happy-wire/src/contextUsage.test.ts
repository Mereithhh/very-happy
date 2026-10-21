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

describe('B-727 window provenance', () => {
    const snapshot = {source:'pi',tokens:1,contextWindow:128000,updatedAt:1};
    it('old snapshots read as configured; unknown strings never fail the parse', async () => {
        const { contextWindowSourceOf } = await import('./contextUsage');
        expect(contextWindowSourceOf(ContextUsageSchema.parse(snapshot))).toBe('configured');
        expect(contextWindowSourceOf(ContextUsageSchema.parse({...snapshot,windowSource:'unknown'}))).toBe('unknown');
        expect(contextWindowSourceOf(ContextUsageSchema.parse({...snapshot,windowSource:'inferred'}))).toBe('inferred');
        expect(contextWindowSourceOf(ContextUsageSchema.parse({...snapshot,windowSource:'from-the-future'}))).toBe('configured');
        expect(ContextUsageSchema.parse({...snapshot,model:'glm-5.3',compactedAt:5})).toMatchObject({model:'glm-5.3',compactedAt:5});
    });
});
