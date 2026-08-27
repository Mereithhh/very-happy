import type { SDKResultMessage } from '../sdk/types';

export function applyClaudeResultLifecycle(
    result: SDKResultMessage | undefined,
    callbacks: {
        closeCompleted: () => void;
        closeFailed: (error: string) => void;
        onFailed: (error: string) => void;
        onCompleted: () => void;
    },
): void {
    if (result && result.subtype !== 'success') {
        const error = result.errors?.filter(Boolean).join('\n').trim() || result.subtype;
        callbacks.closeFailed(error);
        callbacks.onFailed(error);
        return;
    }
    callbacks.closeCompleted();
    callbacks.onCompleted();
}
