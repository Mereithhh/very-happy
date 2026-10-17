/**
 * B-619 shared-session messages — reader side of the header the SERVER
 * writes for a driver's message (happy-server sessionShares.buildSharedMessageText):
 *
 *   [Very Happy shared session message from "<name>" <accountId>]
 *   <text>
 *
 * The server also stamps `meta.sentFrom = 'shared'`, `meta.displayText` (the
 * bare text) and `meta.sharedBy`. The header is for the agent; people see the
 * name as a label on an ordinary user bubble. Metadata is display only, never
 * a privilege.
 */
import type { UserTextMessage } from '@/sync/typesMessage';

export const SHARED_SENT_FROM = 'shared';
const HEADER = /^\[Very Happy shared session message from "([^"]*)" (\S+)\]\n?/;

function decodeHeaderValue(value: string): string {
    return value.replace(/%[0-9A-Fa-f]{2}/g, (hex) => String.fromCharCode(parseInt(hex.slice(1), 16)));
}

export interface PresentedSharedMessage {
    accountId: string | null;
    displayName: string;
    /** The human text (header stripped). */
    body: string;
}

export function presentSharedMessage(message: Pick<UserTextMessage, 'text' | 'meta' | 'displayText'>): PresentedSharedMessage | null {
    if (message.meta?.sentFrom !== SHARED_SENT_FROM) return null;
    const header = message.text.match(HEADER);
    const body = message.displayText ?? message.meta?.displayText ?? (header ? message.text.slice(header[0].length) : message.text);
    const sharedBy = message.meta?.sharedBy;
    return {
        accountId: sharedBy?.accountId ?? header?.[2] ?? null,
        displayName: sharedBy?.displayName ?? (header ? decodeHeaderValue(header[1]) : ''),
        body,
    };
}
