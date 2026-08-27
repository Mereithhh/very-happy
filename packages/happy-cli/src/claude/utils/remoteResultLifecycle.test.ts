import { describe, expect, it, vi } from 'vitest';
import type { SDKResultMessage } from '../sdk/types';
import { applyClaudeResultLifecycle } from './remoteResultLifecycle';

describe('applyClaudeResultLifecycle', () => {
    it('does not run completion side effects for SDK error results', () => {
        const callbacks = {
            closeCompleted: vi.fn(),
            closeFailed: vi.fn(),
            onFailed: vi.fn(),
            onCompleted: vi.fn(),
        };
        applyClaudeResultLifecycle({
            type: 'result', subtype: 'error_during_execution', errors: ['upstream failed'], is_error: true,
        } as SDKResultMessage, callbacks);

        expect(callbacks.closeFailed).toHaveBeenCalledWith('upstream failed');
        expect(callbacks.onFailed).toHaveBeenCalledWith('upstream failed');
        expect(callbacks.closeCompleted).not.toHaveBeenCalled();
        expect(callbacks.onCompleted).not.toHaveBeenCalled();
    });
});
