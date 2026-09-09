import type { PendingAttachment } from '@/utils/MessageQueue2';
import { parseSpecialCommand } from '@/parsers/specialCommands';

type CodexUserTextQueue<T> = {
    push: (message: string, mode: T, attachments?: PendingAttachment[], sourceId?: string) => void;
    pushIsolateAndClear: (message: string, mode: T, attachments?: PendingAttachment[], sourceId?: string) => void;
};

export function isCodexClearText(text: string): boolean {
    return parseSpecialCommand(text).type === 'clear';
}

export function enqueueCodexUserText<T>(opts: {
    text: string;
    mode: T;
    queue: CodexUserTextQueue<T>;
    /** B-332: the web's localId, so a destroyed item can be tombstoned. */
    sourceId?: string;
    attachments?: PendingAttachment[];
}): 'clear' | 'queued' {
    if (isCodexClearText(opts.text)) {
        opts.queue.pushIsolateAndClear(opts.text, opts.mode, opts.attachments, opts.sourceId);
        return 'clear';
    }

    opts.queue.push(opts.text, opts.mode, opts.attachments, opts.sourceId);
    return 'queued';
}
