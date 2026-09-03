/**
 * B-322 —— 心跳租约：把「agent 还在跑」从一个**闩锁**变成一份**会过期的租约**。
 *
 * 铁律 13 已经把活性收敛到「只认 wrapper 每 2s 重发的 keepAlive（`session.thinking`）」，
 * 但只做到一半：**收了、存了，从不检查新鲜度**。`preserveSessionActivityFromStore` 让
 * REST 快照**永远无法**把本地的 `thinking:true` 降回 false，只有 ephemeral activity 或
 * turn 生命周期事件能——于是 wrapper 被硬杀（SIGKILL/OOM/断电/睡死，`finally` 跑不到，
 * 补不出 interrupted tool_result）之后，presence 还是 online、thinking 还是 true，
 * 服务端 presence 超时是 10 分钟阈值 + 60s 轮询，**最长约 11 分钟**里 UI 一直说在跑：
 * 停止按钮在但按了没用（没有活跃 query 可中止），输入被扣在本地队列里出不去。
 *
 * keepAlive 本来就是个标准的 lease/heartbeat —— **`false` 也每 2s 重发**（五个 runner
 * claude/codex/gemini/openclaw/acp 全是 2000ms，自 2026-01 起未变）。缺的只是过期。
 *
 * ## 三条设计约束，每条都对应一次真实的踩坑或反例
 *
 * ① **TTL 必须大于本端已知的最坏正常重连间隔。** keepAlive 走 `socket.volatile.emit`，
 *    断开期间**直接丢弃、不缓冲**；CLI 的主控制 socket 是 `reconnection: false` + 手写
 *    3s 轮询重连；蓝绿发布的 handover 超时上限 10s——**每次发版，所有在跑的会话都会有一段
 *    最长 10 秒的心跳空档**。再叠加 web 侧 activity 累加器 2s 的 debounce。所以 3×2s 会在
 *    每次瞬断和每次发版上假过期，25s 才站得住。放大 TTL 一分钱不亏：要杀的是 11 分钟。
 *
 * ② **本端 socket 断开或标签页不可见期间，租约必须停表。** 这是 PWA，后台冻结是常态：
 *    冻结期间收不到任何 ephemeral **不是因为 CLI 停了，是因为这个 tab 没在听**。更阴的是
 *    冻结的标签页**收不到 `disconnect` 事件**，`socketStatus` 会一直停在 `'connected'`
 *    ——所以判据必须同时看可见性，只看 socket 状态会在它唯一该管用的场景失灵。
 *    停表用「把 lastBeatAt 推到当前」实现，于是恢复后自动获得完整一个 TTL 的宽限，
 *    不需要另一个 grace 常量、也不需要再挂一个 visibility 监听（铁律 13）。
 *
 * ③ **租约不会自己到期。** 心跳停止按定义**不产生任何 store 变更**，因此不触发 re-render；
 *    而 web 上 `sessionsSync` 没有任何周期性轮询（只在 init / resume / socket connect /
 *    new-session 触发），指望「下次 REST 把 thinking 冲掉」永远不会发生。所以必须自带时钟。
 *    用**每会话一次性 `setTimeout`**，不用全局 ticker：全局 `setInterval` 在后台被节流、
 *    回前台会**成批补跑**，把所有会话同时判死（正是 ② 的坑换个形状）；一次性 timer 迟发
 *    反而是想要的方向。空闲会话（thinking=false）根本不武装，零成本。
 *
 * ## 为什么状态放在模块级而不是 store 里
 *
 * `applySessions` 每次都重建 `sessionListViewData`，2s 一次的写入 = 整个侧栏列表数据重算，
 * 正是 B-311 在治的病；挂在 `Session` 上还要再改 `preserveSessionActivityFromStore`，
 * 等于重演它自己在补的那个 bug。先例：`sessionArchiveHold.ts`、`sessionRestore.ts`。
 * 只有一个极小的 bump store 用来触发 re-render，它不进 `sessions`。
 */
import { create } from 'zustand';

/** 见约束 ①。不要往下调；调之前先重新量那四个数。 */
export const HEARTBEAT_LEASE_TTL_MS = 25_000;

const lastBeatAt = new Map<string, number>();
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 只用来把「租约到期」这件事推给 React —— 它不在 `sessions` 里（见文件头）。 */
type LeaseBumpState = { bump: number; tick: () => void };
export const useHeartbeatLeaseBump = create<LeaseBumpState>((set) => ({
    bump: 0,
    tick: () => set((s) => ({ bump: s.bump + 1 })),
}));

export type LeaseInput = {
    /** 本端**收包**时刻（不是服务端 activeAt——跨机时钟不可信）。 */
    lastBeatAt: number | undefined;
    now: number;
    /** 本端 socket 断开 / 标签页不可见 —— 停表，不判死。 */
    suspended: boolean;
};

export type LeaseVerdict = {
    fresh: boolean;
    /** 停表时把计时起点推到当前，于是恢复后自动获得完整一个 TTL 的宽限。 */
    nextLastBeatAt: number | undefined;
};

/** 纯函数，便于测试；副作用在 `evaluateHeartbeat` 里。 */
export function leaseVerdict(input: LeaseInput): LeaseVerdict {
    if (input.suspended) {
        return { fresh: true, nextLastBeatAt: input.lastBeatAt === undefined ? undefined : input.now };
    }
    // 从未观测过心跳 ⇒ 本模块不投反对票。冷启动时 REST 快照本来就写 thinking:false
    // （`sync.ts` 的 processedSession），活性由它自己决定；这里只负责让**已经**为真的
    // thinking 会过期，不负责制造「先按不活」。
    if (input.lastBeatAt === undefined) return { fresh: true, nextLastBeatAt: undefined };
    return { fresh: input.now - input.lastBeatAt < HEARTBEAT_LEASE_TTL_MS, nextLastBeatAt: input.lastBeatAt };
}

function isSuspended(): boolean {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return true;
    return currentSocketStatus() !== 'connected';
}

/**
 * 注入点：避免 `heartbeatLease` import `storage`（storage 侧还要 import 本模块做清理，
 * 会成环）。`sync` 在启动时装上真实读取器。
 */
let currentSocketStatus: () => string = () => 'connected';
export function setHeartbeatSocketStatusReader(reader: () => string): void {
    currentSocketStatus = reader;
}

/**
 * 收到一次会话活动心跳。**必须在 activity 累加器的 debounce 之前调用** ——
 * 累加器对纯时间戳心跳不算 significant change，会压 2s 且计时器不重置，
 * 记在 flush 里等于凭空吃掉 TTL 的净余量。
 */
export function recordHeartbeat(sessionId: string, thinking: boolean, now = Date.now()): void {
    lastBeatAt.set(sessionId, now);
    const existing = expiryTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    expiryTimers.delete(sessionId);
    // 只有「正在跑」才需要一个到期时刻——空闲会话不武装任何 timer（见约束 ③）。
    if (!thinking) return;
    const timer = setTimeout(() => {
        expiryTimers.delete(sessionId);
        useHeartbeatLeaseBump.getState().tick();
    }, HEARTBEAT_LEASE_TTL_MS);
    // Node 环境（测试/SSR）下别让一个挂起的 timer 拖住进程退出。
    (timer as unknown as { unref?: () => void }).unref?.();
    expiryTimers.set(sessionId, timer);
}

/** 当前会话的心跳是否新鲜。停表时会顺带把计时起点推到当前（见约束 ②）。 */
export function isHeartbeatFresh(sessionId: string, now = Date.now()): boolean {
    const verdict = leaseVerdict({ lastBeatAt: lastBeatAt.get(sessionId), now, suspended: isSuspended() });
    if (verdict.nextLastBeatAt === undefined) lastBeatAt.delete(sessionId);
    else lastBeatAt.set(sessionId, verdict.nextLastBeatAt);
    return verdict.fresh;
}

/** 会话被删除时清理，别把 Map 和 timer 漏在这里（B-312 的红点泄漏同形）。 */
export function forgetHeartbeat(sessionId: string): void {
    const timer = expiryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    expiryTimers.delete(sessionId);
    lastBeatAt.delete(sessionId);
}

export function resetHeartbeatLeaseForTest(): void {
    for (const timer of expiryTimers.values()) clearTimeout(timer);
    expiryTimers.clear();
    lastBeatAt.clear();
    currentSocketStatus = () => 'connected';
}

/**
 * React 侧读取口。订阅 bump store，使得「租约到期」这件**不产生任何 store 变更**的事
 * 也能触发一次重渲染（约束 ③）。边际成本≈0：这三个消费方今天已经每 2s 重渲一次
 * （`useSession` 浅比较整个 Session，而 keepAlive 一直在挪 `activeAt`）。
 */
export function useHeartbeatFresh(sessionId: string): boolean {
    useHeartbeatLeaseBump((s) => s.bump);
    return isHeartbeatFresh(sessionId);
}
