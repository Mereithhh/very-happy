/**
 * B-850d: accounts chosen for a launch (fork / automation / team member) on
 * the daemon side. Pure; unit-tested. Spec: specs/2026-11-session-accounts.md
 * 「B-850d」.
 */
import { agentProfileUnavailableReason } from '@slopus/happy-wire';

/**
 * The account a spawn asks for: its own choice, else — for a fork — the
 * parent's binding (null when the parent is unbound = machine login), else
 * undefined (the machine default applies).
 */
export function forkSpawnAccount(
    requested: string | null | undefined,
    parentSessionId: string | undefined,
    parentAccount: (sessionId: string) => string | null,
): string | null | undefined {
    if (requested !== undefined) return requested;
    if (!parentSessionId) return undefined;
    return parentAccount(parentSessionId);
}

const REASON_TEXT: Record<string, string> = {
    'missing': 'does not exist on this machine',
    'missing-secret': 'has no key / token on this machine',
    'expired': 'sign-in has expired',
    'invalid': 'key was rejected',
    'agent-mismatch': 'is for a different agent',
};

/**
 * A daemon spawn error (`agent-profile-unavailable:<reason>: …`) → the line an
 * automation run / team operation reports: what is wrong and the two ways out
 * (sign in again, or choose another account). Null for other errors.
 */
export function accountUnavailableError(error: string, scope: 'automation' | 'team member'): string | null {
    const reason = agentProfileUnavailableReason(error);
    if (!reason) return null;
    const detail = error.replace(/^agent-profile-unavailable:[a-z-]+:?\s*/, '');
    const what = REASON_TEXT[reason] ?? reason;
    return `Account unavailable (${reason}): ${detail ? `${detail} — ` : ''}${what}. Not run on the machine login. ` +
        `Fix: sign in again (Settings → Models & accounts, or \`very-happy account login\` / \`very-happy account test\`), or choose another account for this ${scope}.`;
}
