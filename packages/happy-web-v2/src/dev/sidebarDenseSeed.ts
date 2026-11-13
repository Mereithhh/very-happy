/** DEV-only (B-935): `#sidebar-dense` — the sidebar as a busy account sees it on an
 *  iPad: main agent, Issues on (so 运行看板 shows), a weekly usage bar, and a long
 *  session list. Used for the before / after list-height captures. */
import { storage } from '@/sync/storage';
import type { Machine, Session } from '@/sync/storageTypes';
import { seedMainAgentScene } from './mainAgentSeed';

export const SIDEBAR_DENSE_HASH = '#sidebar-dense';

export function seedSidebarDenseScene(): void {
    const now = Date.now();
    seedMainAgentScene('#main-agent');
    const machines = Object.values(storage.getState().machines);
    storage.getState().applyMachines(machines.map((m) => m.id !== 'dev-machine' ? m : {
        ...m,
        daemonState: { status: 'running', rateLimits: { v: 1, updatedAt: now, providers: { claude: { observedAt: now, windows: [{ kind: 'seven_day', usedPercent: 10, resetsAt: now + 20 * 3600_000, observedAt: now - 1000 }] } } } },
    }) as Machine[]);
    const titles = ['排查退款回调超时', '迁移脚本草稿', '登录页改版', '周报整理', '压测结果复盘', '修复构建里的类型错误', 'CI 缓存命中率', '重写设置页表单', '依赖升级', '日志采样策略', '数据看板口径', '移动端手势', '通知去重', '导出 CSV', '权限审计', '缓存失效排查', '文档站搜索', '发布清单', '值班交接', '回归用例补齐'];
    storage.getState().applySessions(titles.map((text, i) => ({
        id: `dev-dense-${i}`, seq: 1, createdAt: now - 3 * 3600_000, updatedAt: now - (i + 2) * 60_000, active: true, activeAt: now - (i + 2) * 60_000,
        metadata: { machineId: 'dev-machine', path: `/repo/svc-${i % 5}`, host: 'dev-box', flavor: 'claude', summary: { text, updatedAt: now } },
        metadataVersion: 1, agentState: null, agentStateVersion: 1, thinking: false, presence: 'online',
    })) as unknown as Session[]);
}
