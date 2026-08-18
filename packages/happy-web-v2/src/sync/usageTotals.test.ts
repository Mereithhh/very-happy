/**
 * B-136 回归：Usage 设置页的数字曾经是真实值的**恰好 2 倍**。
 *
 * 成因：CLI 上报的 `tokens` / `cost` 对象里，key 是分项
 * （total / input / output / cache_creation / cache_read），而 model key 是另一个
 * 常量字段 'claude-session'。原实现把这些分项 key 当模型名遍历，于是 `total` 和各
 * 分项被一起累加 —— 而 total 本来就等于各分项之和，所以正好翻倍。
 */
import { describe, expect, it } from 'vitest';
import { calculateTotals } from './usageTotals';

/** 一条真实形状的上报（照 apiSession.sendUsageData 构造）。 */
const point = {
    tokens: { total: 1000, input: 600, output: 100, cache_creation: 200, cache_read: 100 },
    cost: { total: 0.5, input: 0.3, output: 0.2 },
};

describe('calculateTotals', () => {
    it('总量取 total，不把分项再加一遍（这就是那个 2 倍 bug）', () => {
        const r = calculateTotals([point]);
        expect(r.totalTokens).toBe(1000);   // 修之前是 2000
        expect(r.totalCost).toBeCloseTo(0.5); // 修之前是 1.0
    });

    it('多条上报正确累加', () => {
        const r = calculateTotals([point, point, point]);
        expect(r.totalTokens).toBe(3000);
        expect(r.totalCost).toBeCloseTo(1.5);
    });

    it('分项按类型分组，且不含 total（否则表里会多一行等于总量的「类型」）', () => {
        const r = calculateTotals([point]);
        expect(r.tokensByKind).toEqual({ input: 600, output: 100, cache_creation: 200, cache_read: 100 });
        expect(Object.keys(r.tokensByKind)).not.toContain('total');
        expect(Object.keys(r.costByKind)).not.toContain('total');
    });

    it('旧上报没有 total 时回落到分项求和', () => {
        const r = calculateTotals([{ tokens: { input: 60, output: 40 }, cost: { input: 0.1, output: 0.2 } }]);
        expect(r.totalTokens).toBe(100);
        expect(r.totalCost).toBeCloseTo(0.3);
    });

    it('非数值与空输入不崩', () => {
        const r = calculateTotals([
            { tokens: { total: 'x' as unknown as number, input: 5 }, cost: {} },
            { tokens: {}, cost: {} },
        ]);
        expect(r.totalTokens).toBe(5);   // total 非数值 → 回落分项
        expect(r.totalCost).toBe(0);
        expect(calculateTotals([]).totalTokens).toBe(0);
    });
});
