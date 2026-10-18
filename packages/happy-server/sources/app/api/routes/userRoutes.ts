import { z } from "zod";
import { Fastify } from "../types";
import { db } from "@/storage/db";
import { RelationshipStatus } from "@prisma/client";
import { friendAdd } from "@/app/social/friendAdd";
import { Context } from "@/context";
import { friendRemove } from "@/app/social/friendRemove";
import { friendList } from "@/app/social/friendList";
import { buildUserProfile } from "@/app/social/type";
import { enforceRelationshipWriteRate } from '@/app/social/relationshipLimits';
import { isAccountResourceLimitError } from '../resourceLimits';
import { displayNameOf, identityOf, searchAccounts } from '@/app/social/accountDirectory';

const userIdSchema = z.string().min(1).max(256);

export async function userRoutes(app: Fastify) {

    // Get user profile
    app.get('/v1/user/:id', {
        schema: {
            params: z.object({
                id: userIdSchema
            }).strict(),
            response: {
                200: z.object({
                    user: UserProfileSchema
                }),
                404: z.object({
                    error: z.literal('User not found')
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const { id } = request.params;

        // Fetch user
        const user = await db.account.findUnique({
            where: {
                id: id
            },
            include: {
                githubUser: true
            }
        });

        if (!user) {
            return reply.code(404).send({ error: 'User not found' });
        }

        // Resolve relationship status
        const relationship = await db.userRelationship.findFirst({
            where: {
                fromUserId: request.userId,
                toUserId: id
            }
        });
        const status: RelationshipStatus = relationship?.status || RelationshipStatus.none;

        // Build user profile
        return reply.send({
            user: buildUserProfile(user, status)
        });
    });

    // Search for users
    app.get('/v1/user/search', {
        schema: {
            querystring: z.object({
                query: z.string().min(1).max(100)
            }).strict(),
            response: {
                200: z.object({
                    users: z.array(UserProfileSchema)
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const { query } = request.query;

        // B-621: directory search — profile handle / login username prefix, or exact email.
        const userProfiles = await searchAccounts(request.userId, query, 10);

        return reply.send({
            users: userProfiles
        });
    });

    // Add friend
    app.post('/v1/friends/add', {
        schema: {
            body: z.object({
                uid: userIdSchema
            }).strict(),
            response: {
                200: z.object({
                    user: UserProfileSchema.nullable()
                }),
                404: z.object({
                    error: z.literal('User not found')
                }),
                429: z.object({ error: z.enum(['relationship_count_quota_exceeded', 'relationship_rate_quota_exceeded']) }),
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        try {
            await enforceRelationshipWriteRate(request.userId);
            const user = await friendAdd(Context.create(request.userId), request.body.uid);
            return reply.send({ user });
        } catch (error) {
            if (isAccountResourceLimitError(error)) {
                return reply.code(429).send({ error: error.code as any });
            }
            throw error;
        }
    });

    app.post('/v1/friends/remove', {
        schema: {
            body: z.object({
                uid: userIdSchema
            }).strict(),
            response: {
                200: z.object({
                    user: UserProfileSchema.nullable()
                }),
                404: z.object({
                    error: z.literal('User not found')
                }),
                429: z.object({ error: z.literal('relationship_rate_quota_exceeded') }),
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        try {
            await enforceRelationshipWriteRate(request.userId);
            const user = await friendRemove(Context.create(request.userId), request.body.uid);
            return reply.send({ user });
        } catch (error) {
            if (isAccountResourceLimitError(error)) {
                return reply.code(429).send({ error: error.code as any });
            }
            throw error;
        }
    });

    app.get('/v1/friends', {
        schema: {
            response: {
                200: z.object({
                    friends: z.array(UserProfileSchema)
                })
            }
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const friends = await friendList(Context.create(request.userId));
        return reply.send({ friends: await Promise.all(friends.map((f) => withDirectoryFields(f))) });
    });
};

// Shared Zod Schemas
const RelationshipStatusSchema = z.enum(['none', 'requested', 'pending', 'friend', 'rejected']);
const UserProfileSchema = z.object({
    id: z.string(),
    firstName: z.string(),
    lastName: z.string().nullable(),
    avatar: z.object({
        path: z.string(),
        url: z.string(),
        width: z.number().optional(),
        height: z.number().optional(),
        thumbhash: z.string().optional()
    }).nullable(),
    username: z.string(),
    bio: z.string().nullable(),
    status: RelationshipStatusSchema,
    // B-621 directory fields (optional so older callers keep parsing).
    displayName: z.string().optional(),
    email: z.string().nullable().optional(),
});

/** Friends list rows carry the same display fields as search results. */
async function withDirectoryFields<P extends { id: string; firstName: string; lastName: string | null; username: string }>(profile: P) {
    const identity = await identityOf(profile.id);
    return {
        ...profile,
        username: profile.username || identity.handle || '',
        displayName: displayNameOf({ firstName: profile.firstName || null, lastName: profile.lastName, username: profile.username || null }, identity),
        email: identity.email,
    };
}
