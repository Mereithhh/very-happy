import { describe, expect, it } from 'vitest';
import { CODEX_CRASH_LOOP_PREFIX, crashLoopNotice, CRASH_LOOP_LIMIT, isCrashLoopBlocked, readCodexResumeCrash, recordCodexCrash, STREAK_WINDOW_MS } from './codexCrashLoop';

const kill = { threadId: 't1', servedTurn: false, signal: 'SIGKILL', code: null };

describe('B-901 codex crash-loop guard', () => {
    it('counts consecutive deaths before any served turn, per thread', () => {
        const one = recordCodexCrash(null, kill, 1_000);
        expect(one).toEqual({ threadId: 't1', count: 1, at: 1_000, signal: 'SIGKILL', code: null });
        expect(isCrashLoopBlocked(one, 't1', 1_000)).toBe(false);
        const two = recordCodexCrash(one, kill, 2_000);
        expect(two?.count).toBe(CRASH_LOOP_LIMIT);
        expect(isCrashLoopBlocked(two, 't1', 2_000)).toBe(true);
        // another thread (after /clear) is not blocked, and restarts the count
        expect(isCrashLoopBlocked(two, 't2', 2_000)).toBe(false);
        expect(recordCodexCrash(two, { ...kill, threadId: 't2' }, 3_000)?.count).toBe(1);
    });

    it('does not count a process that served a turn, or one with no thread', () => {
        expect(recordCodexCrash(null, { ...kill, servedTurn: true }, 1)).toBeNull();
        expect(recordCodexCrash(null, { ...kill, threadId: null }, 1)).toBeNull();
    });

    it('forgets a stale streak so a host given more memory can try again', () => {
        const two = { threadId: 't1', count: 2, at: 0 };
        expect(isCrashLoopBlocked(two, 't1', STREAK_WINDOW_MS - 1)).toBe(true);
        expect(isCrashLoopBlocked(two, 't1', STREAK_WINDOW_MS)).toBe(false);
        expect(recordCodexCrash(two, kill, STREAK_WINDOW_MS)?.count).toBe(1);
    });

    it('reads only a well-formed streak from metadata', () => {
        expect(readCodexResumeCrash(undefined)).toBeNull();
        expect(readCodexResumeCrash({ threadId: 't1', count: 0, at: 1 })).toBeNull();
        expect(readCodexResumeCrash({ threadId: 't1', count: 'x', at: 1 })).toBeNull();
        expect(readCodexResumeCrash({ threadId: 't1', count: 2, at: 5, signal: 'SIGKILL', extra: 1 })).toEqual({ threadId: 't1', count: 2, at: 5, signal: 'SIGKILL' });
    });

    it('the notice carries the stable prefix the Web matches and the likely cause', () => {
        const notice = crashLoopNotice({ threadId: 't1', count: 2, at: 0, signal: 'SIGKILL', code: null });
        expect(notice.startsWith(CODEX_CRASH_LOOP_PREFIX)).toBe(true);
        expect(notice).toContain('most likely out of memory');
        expect(crashLoopNotice({ threadId: 't1', count: 3, at: 0, code: 1 })).toContain('it exited (code=1)');
    });
});
