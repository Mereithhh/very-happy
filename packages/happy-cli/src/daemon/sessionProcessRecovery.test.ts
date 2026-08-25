import { describe, expect, it } from 'vitest';
import { recoverableSessionPid } from './sessionProcessRecovery';

describe('recoverableSessionPid', () => {
    it('requires both persisted identity and a currently verified Happy PID', () => {
        expect(recoverableSessionPid({ hostPid: 42 } as any, new Set([42]))).toBe(42);
        expect(recoverableSessionPid({ hostPid: 42 } as any, new Set([7]))).toBeNull();
        expect(recoverableSessionPid({} as any, new Set([42]))).toBeNull();
    });
});
