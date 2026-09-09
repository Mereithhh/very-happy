import { publishAudit } from './producer';

type Snapshot = { metadata: string; dataEncryptionKey: Uint8Array | null };
export function sessionAuditPayload(session: Snapshot): { metadata: string; dataEncryptionKey: string | null } {
    return { metadata: session.metadata, dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null };
}
export function auditStoredMessages(accountId: string, sessionId: string, snapshot: Snapshot, messages: Array<{
    id: string; seq: number; content: { t: string; c?: string };
}>): void {
    for (const message of messages) {
        if (message.content.t !== 'encrypted' || typeof message.content.c !== 'string') continue;
        publishAudit({ kind: 'message.stored', accountId, sessionId, messageId: message.id, messageSeq: message.seq,
            payload: { ...sessionAuditPayload(snapshot), content: message.content.c } });
    }
}
