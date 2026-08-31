/**
 * 终端 catch-up 调度状态机 —— 纯函数、不持有定时器（spec `specs/2026-08-web-resume-sync.md` §D）。
 *
 * 只管「要不要发起 / 排队 / 失败后何时重试」；RPC 与 apply 主体留在 WebTerminalScreen
 * 的 outChain 里一字不动。
 *
 * 规则：
 *  - gone（daemon 明说终端不存在）后永久忽略；
 *  - 在途时新触发合并为一次 `again`（forceSnapshot 取 OR，不再丢 opts）；
 *  - 标了 `coalesce` 的触发（resume / recovered / relay 边沿 / reconnect，常同时到）在上次成功
 *    1s 内去重；gap 与 forceSnapshot 永不去重——它们证明上次 catch-up 之后又出现了洞；
 *  - 失败按退避重试 1→2→4→8→15s 封顶，最多 MAX_ATTEMPTS 次；`again` 合并进重试而不是
 *    立即再发（否则失败即双发）；新触发重置退避并立即执行。
 */

export type CatchUpOpts = {
    forceSnapshot?: boolean;
    /** Trigger that may be coalesced with a catch-up that just succeeded
     *  (resume / recovered / relay edge / reconnect all tend to land
     *  together). NEVER set for a gap chunk or a blank-screen belt: those
     *  prove a hole AFTER the last catch-up and must always run. */
    coalesce?: boolean;
};
export type CatchUpOutcome = 'ok' | 'fail' | 'gone' | 'aborted';

export const CATCH_UP_DEDUPE_MS = 1_000;
export const CATCH_UP_MAX_ATTEMPTS = 8;
export const CATCH_UP_BACKOFF_CAP_MS = 15_000;

export type CatchUpSchedulerState = {
    phase: 'idle' | 'inflight' | 'backoff' | 'gone';
    again: CatchUpOpts | null;
    attempt: number;
    lastSuccessAt: number | null;
};

export type RequestResult = 'start' | 'queued' | 'ignored';
export type CompleteResult =
    | { action: 'idle' }
    | { action: 'start'; opts: CatchUpOpts }
    | { action: 'retry'; delayMs: number; opts: CatchUpOpts }
    | { action: 'stop' };

export function initialCatchUpState(): CatchUpSchedulerState {
    return { phase: 'idle', again: null, attempt: 0, lastSuccessAt: null };
}

function mergeOpts(a: CatchUpOpts | null, b: CatchUpOpts): CatchUpOpts {
    return { forceSnapshot: !!(a?.forceSnapshot || b.forceSnapshot) };
}

export function backoffDelayMs(attempt: number): number {
    return Math.min(CATCH_UP_BACKOFF_CAP_MS, 1_000 * 2 ** Math.max(0, attempt - 1));
}

/** 外部触发。返回 'start' 时调用方立即发起（并取消任何在等的退避定时器）。 */
export function requestCatchUp(
    s: CatchUpSchedulerState,
    opts: CatchUpOpts,
    now: number,
): { state: CatchUpSchedulerState; result: RequestResult } {
    if (s.phase === 'gone') return { state: s, result: 'ignored' };
    if (s.phase === 'inflight') {
        return { state: { ...s, again: mergeOpts(s.again, opts) }, result: 'queued' };
    }
    if (s.phase === 'idle' && opts.coalesce && !opts.forceSnapshot && s.lastSuccessAt !== null
        && now - s.lastSuccessAt < CATCH_UP_DEDUPE_MS) {
        return { state: s, result: 'ignored' };
    }
    // idle 或 backoff：新触发重置退避，立即执行。
    return { state: { ...s, phase: 'inflight', again: null, attempt: 0 }, result: 'start' };
}

/** 一次 catch-up 结束。调用方按 action 执行：start 立即再发；retry 设定时器；stop/idle 什么都不做。 */
export function completeCatchUp(
    s: CatchUpSchedulerState,
    outcome: CatchUpOutcome,
    now: number,
): { state: CatchUpSchedulerState; result: CompleteResult } {
    if (outcome === 'gone') {
        return { state: { ...s, phase: 'gone', again: null }, result: { action: 'stop' } };
    }
    if (outcome === 'aborted') {
        return { state: { ...s, phase: 'idle', again: null, attempt: 0 }, result: { action: 'stop' } };
    }
    if (outcome === 'ok') {
        const base = { ...s, attempt: 0, lastSuccessAt: now };
        if (s.again) {
            return { state: { ...base, phase: 'inflight', again: null }, result: { action: 'start', opts: s.again } };
        }
        return { state: { ...base, phase: 'idle', again: null }, result: { action: 'idle' } };
    }
    // fail
    const attempt = s.attempt + 1;
    if (attempt >= CATCH_UP_MAX_ATTEMPTS) {
        return { state: { ...s, phase: 'idle', again: null, attempt: 0 }, result: { action: 'stop' } };
    }
    const opts = s.again ?? {};
    return {
        state: { ...s, phase: 'backoff', again: null, attempt },
        result: { action: 'retry', delayMs: backoffDelayMs(attempt), opts },
    };
}

/** 退避定时器到点：进入 inflight。 */
export function beginRetry(s: CatchUpSchedulerState): CatchUpSchedulerState {
    if (s.phase !== 'backoff') return s;
    return { ...s, phase: 'inflight' };
}
