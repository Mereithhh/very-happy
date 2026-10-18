/** B-621 profile handle rules — mirrors the server's PROFILE_USERNAME_PATTERN. Pure, no React. */
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,63}$/;

/** What the handle field says about its current value. Empty is allowed: it clears the handle. */
export function handleIssue(value: string): 'empty' | 'ok' | 'invalid' {
    const v = value.trim().toLowerCase();
    if (!v) return 'empty';
    return HANDLE_PATTERN.test(v) ? 'ok' : 'invalid';
}
