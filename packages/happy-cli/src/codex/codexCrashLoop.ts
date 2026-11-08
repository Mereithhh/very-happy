/**
 * B-901: stop respawning a Codex thread that kills its app-server on load.
 *
 * A thread whose rollout grew to hundreds of MB (long tool outputs are stored
 * whole) needs several GB for `thread/resume`; on a memory-capped host Codex
 * is OOM-killed every time it loads it. Each message respawned and resumed
 * it, each 「重启」 did the same — a loop that can never succeed.
 *
 * The streak lives in session metadata (`codexResumeCrash`) so it survives
 * wrapper restarts. An exit counts when the app-server died before serving a
 * single turn since it was (re)spawned; a served turn clears the streak. Once
 * blocked, the wrapper refuses to spawn Codex for that thread and the Web
 * offers a new Codex session carrying the old one's summary instead. A stale
 * streak (no crash for STREAK_WINDOW_MS) is forgotten, so a host whose memory
 * was raised can try the thread again later.
 */

export type CodexResumeCrash = {
    threadId: string;
    count: number;
    /** epoch ms of the last counted crash */
    at: number;
    signal?: string | null;
    code?: number | null;
};

export const CRASH_LOOP_LIMIT = 2;
export const STREAK_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Stable prefix the Web matches to show the way out (new session with summary). */
export const CODEX_CRASH_LOOP_PREFIX = 'Codex thread crash loop:';

export function readCodexResumeCrash(value: unknown): CodexResumeCrash | null {
    const v = value as Partial<CodexResumeCrash> | null | undefined;
    if (!v || typeof v !== 'object' || typeof v.threadId !== 'string' || !v.threadId) return null;
    if (typeof v.count !== 'number' || !Number.isFinite(v.count) || v.count < 1) return null;
    if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return null;
    return {
        threadId: v.threadId,
        count: Math.floor(v.count),
        at: v.at,
        ...(typeof v.signal === 'string' ? { signal: v.signal } : {}),
        ...(typeof v.code === 'number' ? { code: v.code } : {}),
    };
}

/** The streak after an unexpected app-server exit, or null when this exit does not count. */
export function recordCodexCrash(
    previous: CodexResumeCrash | null,
    exit: { threadId: string | null; servedTurn: boolean; signal: string | null; code: number | null },
    now: number,
): CodexResumeCrash | null {
    if (!exit.threadId || exit.servedTurn) return null;
    const continues = previous && previous.threadId === exit.threadId && now - previous.at < STREAK_WINDOW_MS;
    return {
        threadId: exit.threadId,
        count: continues ? previous.count + 1 : 1,
        at: now,
        signal: exit.signal,
        code: exit.code,
    };
}

export function isCrashLoopBlocked(streak: CodexResumeCrash | null, threadId: string | null | undefined, now: number): boolean {
    return !!streak && !!threadId && streak.threadId === threadId
        && streak.count >= CRASH_LOOP_LIMIT && now - streak.at < STREAK_WINDOW_MS;
}

export function crashLoopNotice(streak: CodexResumeCrash): string {
    const how = streak.signal === 'SIGKILL'
        ? 'it was killed (SIGKILL), most likely out of memory'
        : streak.signal ? `it exited (signal=${streak.signal})` : `it exited (code=${streak.code ?? 'null'})`;
    return `${CODEX_CRASH_LOOP_PREFIX} Codex died ${streak.count} times in a row while loading this thread — ${how}. `
        + 'Very Happy stopped restarting it. Start a new Codex session with a summary of this one to continue.';
}
