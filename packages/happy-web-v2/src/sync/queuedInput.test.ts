import { describe, expect, it, vi } from 'vitest';
import { firstTurnEndForQueuedInput, queuedAtForSend } from './queuedInput';

describe('queued chat input compatibility', () => {
    it('marks ordinary input sent while the agent is working', () => {
        const now = vi.fn(() => 1234);
        expect(queuedAtForSend(true, 'chat', now)).toBe(1234);
        expect(now).toHaveBeenCalledOnce();
    });

    it('does not queue idle input or question/permission answers', () => {
        expect(queuedAtForSend(false, 'chat', () => 1)).toBeUndefined();
        expect(queuedAtForSend(true, 'question', () => 1)).toBeUndefined();
    });

    it('chooses the first durable turn-end after an input, independent of arrival order', () => {
        expect(firstTurnEndForQueuedInput(
            { queuedAt: 9000, seq: 10 },
            [{ createdAt: 3000, seq: 30 }, { createdAt: 2000, seq: 20 }, { createdAt: 1000, seq: 9 }],
        )).toEqual({ createdAt: 2000, seq: 20 });
        expect(firstTurnEndForQueuedInput(
            { queuedAt: 2000 },
            [{ createdAt: 4000 }, { createdAt: 3000 }, { createdAt: 1000 }],
        )).toEqual({ createdAt: 3000 });
        expect(firstTurnEndForQueuedInput(
            { queuedAt: 2000, seq: 40 },
            [{ createdAt: 9000, seq: 30 }],
        )).toBeUndefined();
    });
});
