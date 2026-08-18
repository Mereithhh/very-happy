/**
 * 外部 todo provider 的 web 侧封装（B-007）。
 *
 * 走机器级 RPC 到 daemon，daemon 再跑用户在**那台机器**上配的 provider 命令。
 * 数据不落 server、不缓存——面板是外部系统的一个视图，不是副本。
 *
 * ⚠️ B-003 坑：daemon 侧 handler 抛的错会被 RpcHandlerManager 编码成 `{error}` 的
 * **正常响应**，所以这里必须显式检查 `error` 字段，不能只靠 try/catch。
 */
import { apiSocket } from './apiSocket';
import { ensureMachineEncryption } from './ops';
import { isTimeoutError } from './rpcTimeout';

export type TodoStatus = 'open' | 'done';
export type TodoPriority = 'none' | 'low' | 'medium' | 'high';

export interface TodoItem {
    id: string;
    title: string;
    status: TodoStatus;
    due?: string;
    priority?: TodoPriority;
    group?: string;
    note?: string;
}

export { todoFailureOf } from './todoFailure';
export type { TodoFailure, TodoFailureCode } from './todoFailure';
import { todoFailureOf, type TodoFailure } from './todoFailure';

export type TodoListResult =
    | { ok: true; items: TodoItem[]; dropped: number; truncated: boolean }
    | TodoFailure;

async function call<R>(machineId: string, method: string, params: unknown): Promise<R | TodoFailure> {
    try {
        await ensureMachineEncryption(machineId);
        const res = await apiSocket.machineRPC<R & { error?: string }, unknown>(machineId, method, params);
        if (typeof res?.error === 'string') return todoFailureOf(res.error);
        return res as R;
    } catch (error) {
        if (isTimeoutError(error)) return { ok: false, code: 'timeout', error: `${method} timed out` };
        return todoFailureOf(error instanceof Error ? error.message : `${method} failed`);
    }
}

/** 拉取该机器上的待办。永不抛。 */
export async function machineTodoList(machineId: string): Promise<TodoListResult> {
    const res = await call<{ items: TodoItem[]; dropped: number; truncated: boolean }>(machineId, 'todo-list', {});
    if ('ok' in res && res.ok === false) return res;
    const r = res as { items?: unknown; dropped?: unknown; truncated?: unknown };
    if (!Array.isArray(r.items)) {
        return { ok: false, code: 'unknown', error: 'Malformed todo-list response' };
    }
    return {
        ok: true,
        items: r.items as TodoItem[],
        dropped: typeof r.dropped === 'number' ? r.dropped : 0,
        truncated: r.truncated === true,
    };
}

/** 标记完成。结果不解析——调用方必须重新 list，以外部系统的实际状态为准。 */
export async function machineTodoComplete(machineId: string, id: string): Promise<{ ok: true } | TodoFailure> {
    const res = await call<{ ok: true }>(machineId, 'todo-complete', { id });
    return 'ok' in res && res.ok === false ? res : { ok: true };
}

/** 新建。同上，结果不解析。 */
export async function machineTodoCreate(machineId: string, title: string): Promise<{ ok: true } | TodoFailure> {
    const res = await call<{ ok: true }>(machineId, 'todo-create', { title });
    return 'ok' in res && res.ok === false ? res : { ok: true };
}
