/**
 * 用量汇总（B-136）—— 纯函数、零副作用 import。
 *
 * 从 `apiUsage.ts` 抽出来有两个原因：①那边的 import 链会拽进 apiSocket →
 * localStorage，node 测试环境加载不了；②这段逻辑曾经把数字算成真实值的 **2 倍**，
 * 必须有测试钉死。
 */

export interface UsageTotalsInput {
    tokens: Record<string, unknown>;
    cost: Record<string, unknown>;
}

export interface UsageTotals {
    totalTokens: number;
    totalCost: number;
    tokensByKind: Record<string, number>;
    costByKind: Record<string, number>;
}

export function calculateTotals(usage: UsageTotalsInput[]): UsageTotals {
    // B-136: 这里的 key **不是模型名**。CLI 上报时 model key 是常量 'claude-session'
    // （apiSession.ts sendUsageData），而 `tokens` / `cost` 对象的 key 是
    // total / input / output / cache_creation / cache_read —— 是**分项**。
    //
    // 原实现把这些 key 当模型名遍历，于是：
    //   ① 「By Model」列出的其实是 total/input/output/cache_*；
    //   ② `total` 与各分项被**一起**累加，总量恰好是真实值的 2 倍。
    // 修法：总量只取 `total`（缺失才回落到分项求和），分项排除 `total` 后按类型展示。
    const result = {
        totalTokens: 0,
        totalCost: 0,
        tokensByKind: {} as Record<string, number>,
        costByKind: {} as Record<string, number>
    };

    const accumulate = (
        source: Record<string, unknown>,
        addTotal: (n: number) => void,
        byKind: Record<string, number>,
    ) => {
        const total = source.total;
        if (typeof total === 'number') {
            addTotal(total);
        } else {
            // 旧上报没有 total：退回到分项求和（此时分项之和才是总量）
            for (const [kind, value] of Object.entries(source)) {
                if (kind !== 'total' && typeof value === 'number') addTotal(value);
            }
        }
        for (const [kind, value] of Object.entries(source)) {
            if (kind === 'total' || typeof value !== 'number') continue;
            byKind[kind] = (byKind[kind] || 0) + value;
        }
    };

    for (const dataPoint of usage) {
        accumulate(dataPoint.tokens as Record<string, unknown>, (n) => { result.totalTokens += n; }, result.tokensByKind);
        accumulate(dataPoint.cost as Record<string, unknown>, (n) => { result.totalCost += n; }, result.costByKind);
    }

    return result;
}
