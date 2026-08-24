export interface LocalSignupBootstrap {
    signupMode: string;
    signupInviteCodes?: string;
    generatedInviteCode?: string;
}

/** A fresh server bootstraps through a private invite, never open signup. */
export function resolveLocalSignupBootstrap(
    configuredMode: string | undefined,
    configuredInviteCodes: string | undefined,
    generatedInviteCode: string,
): LocalSignupBootstrap {
    const signupMode = configuredMode?.trim() || 'invite';
    const inviteCodes = configuredInviteCodes?.trim();

    if (signupMode !== 'invite' || inviteCodes) {
        return { signupMode, signupInviteCodes: inviteCodes || undefined };
    }

    return {
        signupMode,
        signupInviteCodes: generatedInviteCode,
        generatedInviteCode,
    };
}
