import { enforceAccountWriteRate, lockAccountResources, reserveAccountMessages } from '@/app/api/resourceLimits';
import { utf8StringSchema } from '@/app/api/resourceSchemas';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { allocateSessionSeqBatch } from '@/storage/seq';
import { z } from 'zod';

// Align with the default Socket.IO transport ceiling. The envelope is also
// counted by Socket.IO, so transport validation may reject slightly earlier.
export const SESSION_MESSAGE_CONTENT_MAX_BYTES = 1024 * 1024;
export const SESSION_MESSAGE_LOCAL_ID_MAX_BYTES = 256;

export type SessionMessageWrite = {
    content: string;
    localId: string | null;
};

const sessionMessageWritesSchema = z.array(z.object({
    content: utf8StringSchema({ maxBytes: SESSION_MESSAGE_CONTENT_MAX_BYTES }),
    localId: utf8StringSchema({ maxBytes: SESSION_MESSAGE_LOCAL_ID_MAX_BYTES }).nullable(),
})).min(1).max(100);

export type StoredSessionMessage = {
    id: string;
    sessionId: string;
    seq: number;
    content: PrismaJson.SessionMessageContent;
    localId: string | null;
    createdAt: Date;
    updatedAt: Date;
};

export type StoredSessionMessageWithUpdate = StoredSessionMessage & { updateSeq: number };

/**
 * The one persistent message writer for HTTP and Socket.IO ingress.
 * Duplicate localIds are idempotent and do not consume storage quota.
 */
export async function storeSessionMessages(options: {
    accountId: string;
    sessionId: string;
    messages: SessionMessageWrite[];
}): Promise<{
    messages: StoredSessionMessage[];
    createdMessages: StoredSessionMessageWithUpdate[];
}> {
    const parsedMessages = sessionMessageWritesSchema.parse(options.messages);
    const firstByLocalId = new Map<string, SessionMessageWrite>();
    const messagesWithoutLocalId: SessionMessageWrite[] = [];
    for (const message of parsedMessages) {
        if (message.localId === null) messagesWithoutLocalId.push(message);
        else if (!firstByLocalId.has(message.localId)) firstByLocalId.set(message.localId, message);
    }
    const uniqueMessages = [...firstByLocalId.values(), ...messagesWithoutLocalId];

    return inTx(async (tx) => {
        // Use the repository-wide Account → child-row lock order. The Account
        // lock is O(1): quota reads counters maintained by a database trigger,
        // never an aggregate scan of the account's message history.
        await lockAccountResources(tx, options.accountId);
        await tx.$queryRawUnsafe(
            `SELECT "id" FROM "Session"
             WHERE "id" = $1 AND "accountId" = $2
             FOR UPDATE`,
            options.sessionId,
            options.accountId,
        );
        const localIds = [...firstByLocalId.keys()];
        const existing = localIds.length > 0
            ? await tx.sessionMessage.findMany({
                where: { sessionId: options.sessionId, localId: { in: localIds } },
            })
            : [];
        const existingLocalIds = new Set(existing.flatMap((message) => message.localId !== null ? [message.localId] : []));
        const newMessages = uniqueMessages.filter((message) => (
            message.localId === null || !existingLocalIds.has(message.localId)
        ));
        // Daemons replay pending localIds after reconnect/restart. Charge only
        // rows that will actually be inserted; charging idempotent retries can
        // turn a normal multi-session replay into a permanent 429 retry storm.
        if (newMessages.length > 0) {
            await enforceAccountWriteRate({
                accountId: options.accountId,
                resource: 'message',
                units: newMessages.length,
                envName: 'MAX_MESSAGES_PER_ACCOUNT_PER_MINUTE',
                fallback: 600,
            }, tx);
        }
        const encoded = newMessages.map((message) => ({
            input: message,
            content: { t: 'encrypted' as const, c: message.content },
        }));
        const incomingBytes = encoded.reduce(
            (total, message) => total + Buffer.byteLength(message.input.content, 'utf8'),
            0,
        );
        const updateSeqs = await reserveAccountMessages(tx, options.accountId, {
            count: newMessages.length,
            bytes: incomingBytes,
        });
        const seqs = await allocateSessionSeqBatch(options.sessionId, newMessages.length, tx);
        const createdMessagesWithoutUpdates: StoredSessionMessage[] = [];
        for (let index = 0; index < encoded.length; index += 1) {
            const message = encoded[index];
            const created = await tx.sessionMessage.create({
                data: {
                    sessionId: options.sessionId,
                    seq: seqs[index],
                    content: message.content,
                    localId: message.input.localId,
                },
            });
            createdMessagesWithoutUpdates.push(created as StoredSessionMessage);
        }
        const createdMessages = createdMessagesWithoutUpdates.map((message, index) => ({
            ...message,
            updateSeq: updateSeqs[index],
        }));

        return {
            messages: [...existing, ...createdMessages].sort((left, right) => left.seq - right.seq) as StoredSessionMessage[],
            createdMessages,
        };
    });
}
