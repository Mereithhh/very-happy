import type { PendingAttachment } from '@/utils/MessageQueue2';
import { compactCommandText, parseSpecialCommand } from '@/parsers/specialCommands';

type CodexUserTextQueue<T> = {
    push: (message: string, mode: T, attachments?: PendingAttachment[], sourceId?: string) => void;
    pushNonUser: (message: string, mode: T, attachments?: PendingAttachment[], sourceId?: string) => void;
    pushIsolate: (message: string, mode: T, attachments?: PendingAttachment[], sourceId?: string) => void;
    pushIsolateAndClear: (message: string, mode: T, attachments?: PendingAttachment[], sourceId?: string) => void;
};

export function isCodexClearText(text: string): boolean {
    return parseSpecialCommand(text).type === 'clear';
}

/** `/compact [instructions]` → the canonical command, else null. */
export function codexCompactCommand(text: string): string | null {
    return compactCommandText(text);
}

/** A command the wrapper runs itself: never steered into a turn or sent to the model. */
export function isCodexControlText(text: string): boolean {
    return isCodexClearText(text) || codexCompactCommand(text) !== null;
}

export function enqueueCodexUserText<T>(opts: {
    text: string;
    mode: T;
    queue: CodexUserTextQueue<T>;
    /** B-332: the web's localId, so a destroyed item can be tombstoned. */
    sourceId?: string;
    attachments?: PendingAttachment[];
    /** B-940: another session's message — a turn of its own, never joined with the owner's text. */
    nonUser?: boolean;
}): 'clear' | 'compact' | 'queued' {
    if (isCodexClearText(opts.text)) {
        opts.queue.pushIsolateAndClear(opts.text, opts.mode, opts.attachments, opts.sourceId);
        return 'clear';
    }

    // `/compact` is a turn of its own: joined with its neighbours it is chat.
    const compact = codexCompactCommand(opts.text);
    if (compact !== null) {
        opts.queue.pushIsolate(compact, opts.mode, opts.attachments, opts.sourceId);
        return 'compact';
    }

    if (opts.nonUser) opts.queue.pushNonUser(opts.text, opts.mode, opts.attachments, opts.sourceId);
    else opts.queue.push(opts.text, opts.mode, opts.attachments, opts.sourceId);
    return 'queued';
}
