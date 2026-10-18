import { Context } from "@/context";
import { buildUserProfile, UserProfile } from "./type";
import { inTx } from "@/storage/inTx";
import { RelationshipStatus } from "@prisma/client";
import { relationshipSet } from "./relationshipSet";
import { relationshipGet } from "./relationshipGet";
import { lockRelationshipAccounts } from './relationshipLimits';
import { notifyRelationshipChanged } from './relationshipEvents';

/**
 * One verb for every "undo" on a relationship (B-621 semantics, first UI):
 *   friend    → unfriend: both sides back to none
 *   requested → cancel my request: both sides none (their pending disappears)
 *   pending   → decline their request: my side `rejected` (a repeat request
 *               from them stays silent), their side none
 *   rejected  → forget the rejection: my side none
 */
export async function friendRemove(ctx: Context, uid: string): Promise<UserProfile | null> {
    return await inTx(async (tx) => {
        const currentUser = await tx.account.findUnique({ where: { id: ctx.uid }, include: { githubUser: true } });
        const targetUser = await tx.account.findUnique({ where: { id: uid }, include: { githubUser: true } });
        if (!currentUser || !targetUser || currentUser.id === targetUser.id) {
            return null;
        }
        await lockRelationshipAccounts(tx, currentUser.id, targetUser.id);

        const mine = await relationshipGet(tx, currentUser.id, targetUser.id);
        const theirs = await relationshipGet(tx, targetUser.id, currentUser.id);

        if (mine === RelationshipStatus.friend || mine === RelationshipStatus.requested) {
            await relationshipSet(tx, currentUser.id, targetUser.id, RelationshipStatus.none);
            if (theirs !== RelationshipStatus.rejected) {
                await relationshipSet(tx, targetUser.id, currentUser.id, RelationshipStatus.none);
            }
            notifyRelationshipChanged(tx, [
                { userId: currentUser.id, uid: targetUser.id, status: RelationshipStatus.none },
                { userId: targetUser.id, uid: currentUser.id, status: theirs === RelationshipStatus.rejected ? theirs : RelationshipStatus.none },
            ]);
            return buildUserProfile(targetUser, RelationshipStatus.none);
        }

        if (mine === RelationshipStatus.pending) {
            await relationshipSet(tx, currentUser.id, targetUser.id, RelationshipStatus.rejected);
            await relationshipSet(tx, targetUser.id, currentUser.id, RelationshipStatus.none);
            notifyRelationshipChanged(tx, [
                { userId: currentUser.id, uid: targetUser.id, status: RelationshipStatus.rejected },
                { userId: targetUser.id, uid: currentUser.id, status: RelationshipStatus.none },
            ]);
            return buildUserProfile(targetUser, RelationshipStatus.rejected);
        }

        if (mine === RelationshipStatus.rejected) {
            await relationshipSet(tx, currentUser.id, targetUser.id, RelationshipStatus.none);
            notifyRelationshipChanged(tx, [{ userId: currentUser.id, uid: targetUser.id, status: RelationshipStatus.none }]);
            return buildUserProfile(targetUser, RelationshipStatus.none);
        }

        return buildUserProfile(targetUser, mine);
    });
}
