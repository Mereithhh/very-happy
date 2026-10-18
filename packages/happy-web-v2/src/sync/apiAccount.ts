/**
 * B-621 account profile API — display name + public handle.
 * The handle is what colleagues search for and share to; changing it never
 * touches the login username (password accounts keep theirs).
 */
import * as z from 'zod';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { assertNotAuthFailure } from '@/auth/authLatch';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

export type ProfilePatch = { firstName?: string | null; lastName?: string | null; username?: string | null };

export class ProfileApiError extends Error {
    constructor(readonly code: 'username_taken' | 'invalid_username' | 'too_many_requests' | 'unknown', readonly status: number) {
        super(code);
    }
}

const ProfilePatchResponse = z.object({ firstName: z.string().nullable(), lastName: z.string().nullable(), username: z.string().nullable() });

export async function updateProfile(credentials: AuthCredentials, patch: ProfilePatch): Promise<z.infer<typeof ProfilePatchResponse>> {
    const response = await fetch(`${getServerUrl()}/v1/account/profile`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        },
        body: JSON.stringify(patch),
    });
    assertNotAuthFailure(response, 'apiAccount');
    if (!response.ok) {
        let code: ProfileApiError['code'] = 'unknown';
        try {
            const body = await response.json() as { error?: string };
            if (body.error === 'username_taken' || body.error === 'invalid_username' || body.error === 'too_many_requests') code = body.error;
        } catch { /* body is not json */ }
        throw new ProfileApiError(code, response.status);
    }
    return ProfilePatchResponse.parse(await response.json());
}
