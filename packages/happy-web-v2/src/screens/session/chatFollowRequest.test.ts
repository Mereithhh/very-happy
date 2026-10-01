import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { latestOwnSendKey, onChatFollowRequest, requestChatFollow } from './chatFollowRequest';

describe('B-520 follow on send', () => {
    it('picks the newest in-flight message of this client only', () => {
        const m = (localId: string, sendState?: 'sending' | 'failed') => ({ kind: 'user-text', id: localId, localId, createdAt: 1, text: '', ...(sendState ? { sendState } : {}) }) as Message;
        expect(latestOwnSendKey([m('c', 'sending'), m('b'), m('a', 'sending')])).toBe('c');
        expect(latestOwnSendKey([m('b'), m('x', 'failed')])).toBeNull();
    });
    it('delivers a request to the listeners of that session only', () => {
        const a = vi.fn(); const b = vi.fn();
        const offA = onChatFollowRequest('s1', a); const offB = onChatFollowRequest('s2', b);
        requestChatFollow('s1');
        expect(a).toHaveBeenCalledTimes(1); expect(b).not.toHaveBeenCalled();
        offA(); offB();
        requestChatFollow('s1');
        expect(a).toHaveBeenCalledTimes(1);
    });
});
