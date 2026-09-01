/**
 * B-262 A3 执行层：把 storage 收集的执法决策变成 RPC。
 *
 * - `rpc`：一次 `set-permission-mode bypassPermissions`——0.2.89+ 的 CLI 会放行全部
 *   pending 普通工具并把 SDK 切到 bypass，之后不再问；失败退化为逐卡 allow。
 * - `allow`：裸 `permission` allow（**不带 mode**：0.2.79–0.2.90 在 canUseTool 内嵌套
 *   SDK control request，失败即 deny）。
 * - 去重只记**成功**；失败按 session 退避（进程离线 15s/30s 才失败，presence 滞后 10 分钟）。
 * - 多设备同时代批：CLI 对已解决请求 no-op（v0.2.55 起幂等）。
 */
import { apiSocket } from './apiSocket';
import { storage, type YoloEnforcementDecision } from './storage';

const handled = new Map<string, Set<string>>();        // sessionId → requestIds done
const backoffUntil = new Map<string, number>();        // sessionId → epoch ms
const inFlight = new Map<string, Promise<void>>();     // sessionId → serialized run
const BACKOFF_START_MS = 5_000;
const BACKOFF_CAP_MS = 60_000;
const backoffStep = new Map<string, number>();

function markHandled(sessionId: string, requestId: string) {
    let set = handled.get(sessionId);
    if (!set) { set = new Set(); handled.set(sessionId, set); }
    set.add(requestId);
}

function noteFailure(sessionId: string, now: number) {
    const step = Math.min(BACKOFF_CAP_MS, (backoffStep.get(sessionId) ?? BACKOFF_START_MS / 2) * 2);
    backoffStep.set(sessionId, step);
    backoffUntil.set(sessionId, now + step);
}

function noteSuccess(sessionId: string) {
    backoffStep.delete(sessionId);
    backoffUntil.delete(sessionId);
}

async function allowOne(sessionId: string, requestId: string): Promise<boolean> {
    try {
        await apiSocket.sessionRPC(sessionId, 'permission', { id: requestId, approved: true, decision: 'approved' });
        markHandled(sessionId, requestId);
        storage.getState().markYoloAutoApproved(sessionId, requestId);
        return true;
    } catch {
        return false;
    }
}

async function runForSession(sessionId: string, decisions: YoloEnforcementDecision[], now: () => number): Promise<void> {
    const pending = decisions.filter((d) => !handled.get(sessionId)?.has(d.requestId));
    if (pending.length === 0) return;
    if ((backoffUntil.get(sessionId) ?? 0) > now()) return;
    let ok = false;
    if (pending.some((d) => d.action === 'rpc')) {
        try {
            await apiSocket.sessionRPC(sessionId, 'set-permission-mode', { mode: 'bypassPermissions' }, { timeoutMs: 20_000 });
            for (const d of pending) markHandled(sessionId, d.requestId);
            ok = true;
        } catch {
            // Old idle handler missing / query gap / offline: fall through to bare allows.
        }
    }
    if (!ok) {
        for (const d of pending) {
            if (await allowOne(sessionId, d.requestId)) ok = true;
        }
    }
    if (ok) noteSuccess(sessionId); else noteFailure(sessionId, now());
}

/** Entry registered into storage via setPermissionEnforcer. Serialized per session. */
export function runYoloEnforcement(decisions: YoloEnforcementDecision[], now: () => number = () => Date.now()): void {
    const bySession = new Map<string, YoloEnforcementDecision[]>();
    for (const d of decisions) {
        const list = bySession.get(d.sessionId) ?? [];
        list.push(d);
        bySession.set(d.sessionId, list);
    }
    for (const [sessionId, list] of bySession) {
        const prev = inFlight.get(sessionId) ?? Promise.resolve();
        const next = prev.then(() => runForSession(sessionId, list, now)).catch(() => undefined);
        inFlight.set(sessionId, next);
        void next.finally(() => { if (inFlight.get(sessionId) === next) inFlight.delete(sessionId); });
    }
}

/** Test hook. */
export function resetYoloEnforcerState() {
    handled.clear(); backoffUntil.clear(); inFlight.clear(); backoffStep.clear();
}
