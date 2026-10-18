import * as z from 'zod';

//
// Relationship Status
//

export const RelationshipStatusSchema = z.enum(['none', 'requested', 'pending', 'friend', 'rejected']);
export type RelationshipStatus = z.infer<typeof RelationshipStatusSchema>;

//
// User Profile (Friend)
//

export const UserProfileSchema = z.object({
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
    // B-621 directory fields — optional so an older server still parses.
    displayName: z.string().optional(),
    email: z.string().nullable().optional(),
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

// Friend Request type no longer used in new API

//
// Relationship Updated Event
//

export const RelationshipUpdatedEventSchema = z.object({
    fromUserId: z.string(),
    toUserId: z.string(),
    status: RelationshipStatusSchema,
    action: z.enum(['created', 'updated', 'deleted']),
    fromUser: UserProfileSchema.optional(),
    toUser: UserProfileSchema.optional(),
    timestamp: z.number()
});

export type RelationshipUpdatedEvent = z.infer<typeof RelationshipUpdatedEventSchema>;

//
// API Response Types
//

export const UserResponseSchema = z.object({
    user: UserProfileSchema
});

export type UserResponse = z.infer<typeof UserResponseSchema>;

export const FriendsResponseSchema = z.object({
    friends: z.array(UserProfileSchema)
});

export type FriendsResponse = z.infer<typeof FriendsResponseSchema>;

export const UsersSearchResponseSchema = z.object({
    users: z.array(UserProfileSchema)
});

export type UsersSearchResponse = z.infer<typeof UsersSearchResponseSchema>;

//
// Utility functions
//

export function getDisplayName(profile: UserProfile): string {
    if (profile.displayName) return profile.displayName;
    const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    return fullName || profile.username || profile.email || profile.id;
}

export function isFriend(status: RelationshipStatus): boolean {
    return status === 'friend';
}

export function isPendingRequest(status: RelationshipStatus): boolean {
    return status === 'pending';
}

export function isRequested(status: RelationshipStatus): boolean {
    return status === 'requested';
}