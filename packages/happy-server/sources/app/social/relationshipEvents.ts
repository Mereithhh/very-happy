/**
 * B-621: tell both sides of a relationship change over the socket so the
 * People screen and the share picker update without a refetch. Emitted after
 * the transaction commits (`afterTx`), one user-scoped update per account.
 */
import type { RelationshipStatus } from '@prisma/client';
import { afterTx, type Tx } from '@/storage/inTx';
import { allocateUserSeq } from '@/storage/seq';
import { randomKeyNaked } from '@/utils/randomKeyNaked';
import { buildRelationshipUpdatedEvent, eventRouter } from '@/app/events/eventRouter';

export function notifyRelationshipChanged(tx: Tx, pairs: Array<{ userId: string; uid: string; status: RelationshipStatus }>): void {
    afterTx(tx, async () => {
        const timestamp = Date.now();
        for (const pair of pairs) {
            const seq = await allocateUserSeq(pair.userId);
            eventRouter.emitUpdate({
                userId: pair.userId,
                payload: buildRelationshipUpdatedEvent({ uid: pair.uid, status: pair.status, timestamp }, seq, randomKeyNaked(12)),
                recipientFilter: { type: 'user-scoped-only' },
            });
        }
    });
}
