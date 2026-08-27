import type { Message } from './typesMessage';
import type { NormalizedMessage } from './typesRaw';

type OrderedModeMessage = {
    id: string;
    seq?: number | null;
    createdAt: number;
    permissionMode: string;
};

function newest(items: OrderedModeMessage[]): OrderedModeMessage | undefined {
    return items.sort((a, b) => {
        if (typeof a.seq === 'number' && typeof b.seq === 'number' && a.seq !== b.seq) return b.seq - a.seq;
        return b.createdAt - a.createdAt;
    })[0];
}

function existingUserModes(messages: readonly Message[]): OrderedModeMessage[] {
    return messages.flatMap((message) => {
        const mode = message.kind === 'user-text' ? message.meta?.permissionMode?.trim() : undefined;
        return mode ? [{ id: message.id, seq: message.seq, createdAt: message.createdAt, permissionMode: mode }] : [];
    });
}

function incomingUserModes(messages: readonly NormalizedMessage[]): OrderedModeMessage[] {
    return messages.flatMap((message) => {
        const mode = message.role === 'user' ? message.meta?.permissionMode?.trim() : undefined;
        return mode ? [{ id: message.id, seq: message.seq, createdAt: message.createdAt, permissionMode: mode }] : [];
    });
}

/**
 * Rehydrate the composer mode from the latest sent user turn. Only a new user
 * message can move the UI: assistant traffic and older history pages must not
 * overwrite a local mode selected for the next, not-yet-sent turn.
 */
export function resolveIncomingPermissionMode(
    existing: readonly Message[],
    incoming: readonly NormalizedMessage[],
): string | undefined {
    const next = newest(incomingUserModes(incoming));
    if (!next) return undefined;

    const current = newest(existingUserModes(existing));
    if (!current || current.id === next.id) return next.permissionMode;
    if (typeof next.seq === 'number' && typeof current.seq === 'number') {
        return next.seq > current.seq ? next.permissionMode : undefined;
    }
    return next.createdAt > current.createdAt ? next.permissionMode : undefined;
}
