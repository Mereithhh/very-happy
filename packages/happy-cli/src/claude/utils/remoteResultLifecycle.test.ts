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

    it('treats a success frame with is_error as failed, using the result text (B-275 auth failure)', () => {
        const callbacks = {
            closeCompleted: vi.fn(),
            closeFailed: vi.fn(),
            onFailed: vi.fn(),
            onCompleted: vi.fn(),
        };
        applyClaudeResultLifecycle({
            type: 'result', subtype: 'success', is_error: true,
            result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        } as SDKResultMessage, callbacks);

        expect(callbacks.closeFailed).toHaveBeenCalledWith('Failed to authenticate: OAuth session expired and could not be refreshed');
        expect(callbacks.onFailed).toHaveBeenCalledWith('Failed to authenticate: OAuth session expired and could not be refreshed');
        expect(callbacks.closeCompleted).not.toHaveBeenCalled();
        expect(callbacks.onCompleted).not.toHaveBeenCalled();
    });

    it('prefers structured errors over result text, and falls back to subtype', () => {
        const mk = () => ({ closeCompleted: vi.fn(), closeFailed: vi.fn(), onFailed: vi.fn(), onCompleted: vi.fn() });
        const a = mk();
        applyClaudeResultLifecycle({ type: 'result', subtype: 'success', is_error: true, errors: ['boom'], result: 'text' } as unknown as SDKResultMessage, a);
        expect(a.closeFailed).toHaveBeenCalledWith('boom');
        const b = mk();
        applyClaudeResultLifecycle({ type: 'result', subtype: 'error_max_turns', is_error: true } as SDKResultMessage, b);
        expect(b.closeFailed).toHaveBeenCalledWith('error_max_turns');
    });

    it('completes a normal success frame', () => {
        const callbacks = { closeCompleted: vi.fn(), closeFailed: vi.fn(), onFailed: vi.fn(), onCompleted: vi.fn() };
        applyClaudeResultLifecycle({ type: 'result', subtype: 'success', is_error: false, result: 'ok' } as SDKResultMessage, callbacks);
        expect(callbacks.closeCompleted).toHaveBeenCalledOnce();
        expect(callbacks.onCompleted).toHaveBeenCalledOnce();
        expect(callbacks.closeFailed).not.toHaveBeenCalled();
    });
});
