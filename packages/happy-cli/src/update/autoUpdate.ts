/**
 * B-327 — install a new CLI by itself, but only when doing so cannot interrupt
 * anyone.
 *
 * The dangerous half of an upgrade is the handover, and that is already fenced:
 * B-321 runs the replacement bundle before the daemon gives up ownership, holds
 * on the old code when it will not start, and reports why. So all this adds is
 * "run npm", and it adds it under conditions chosen so a failure costs nothing:
 *
 * - **Idle only.** No session wrapper running, no live web terminal. An upgrade
 *   swaps the daemon; wrappers already running keep the code they started with
 *   (iron rule 14), and a terminal's owner process is replaced underneath it.
 *   Waiting for idle means neither is ever true at the moment we act.
 * - **To the relay's recommended version, never `latest`.** The operator pins
 *   that after validating a release, so nothing reaches a user's machine that
 *   has not been deliberately promoted — the blast radius is a decision, not a
 *   publish.
 * - **One attempt per version.** A version that fails to install is not retried
 *   in a loop; the next attempt needs a newer recommendation or a restart. npm
 *   has already left a half-written tree in production once, and hammering it is
 *   how a bad state becomes a permanent one.
 */
import { compareExactVersions } from './cliUpdate';

export type AutoUpdateDecision =
    | { action: 'install'; version: string }
    | { action: 'skip'; reason: string };

export interface AutoUpdateContext {
    /** Machine-level setting; `off` disables this entirely. */
    enabled: boolean;
    /** What the daemon is running right now. */
    currentVersion: string;
    /** The relay's recommendation. `null` when the operator has pinned nothing. */
    recommendedVersion: string | null;
    /** No session wrappers and no live web terminals. */
    idle: boolean;
    /** Version this daemon already tried and failed to install, if any. */
    failedVersion?: string | null;
}

export function decideAutoUpdate(context: AutoUpdateContext): AutoUpdateDecision {
    if (!context.enabled) return { action: 'skip', reason: 'auto-update disabled' };
    const target = context.recommendedVersion;
    // Nothing pinned means the operator has not promoted a release yet. Silence
    // is not permission to take whatever npm currently calls latest.
    if (!target) return { action: 'skip', reason: 'no recommended version published' };
    // B-329: only ever move FORWARD. Comparing for equality was not enough —
    // a machine running something newer than the recommendation (which is the
    // normal state right after a release, before the operator promotes it) fell
    // through and would have installed the older version the next time it was
    // idle. Auto-update must never be able to downgrade a machine.
    const ordering = compareExactVersions(context.currentVersion, target);
    if (ordering === null) return { action: 'skip', reason: 'version numbers not comparable' };
    if (ordering === 0) return { action: 'skip', reason: 'already current' };
    if (ordering > 0) return { action: 'skip', reason: `already ahead of the recommended ${target}` };
    if (context.failedVersion === target) {
        return { action: 'skip', reason: `already failed to install ${target} once` };
    }
    if (!context.idle) return { action: 'skip', reason: 'machine is busy' };
    return { action: 'install', version: target };
}

/**
 * The exact install. Pinned version, and the same narrow script allowlist the
 * documented manual command uses (iron rule 7) — `very-happy-cli`'s tool unpack
 * and `node-pty`'s prebuild hook, nothing else, so npm's deny-by-default posture
 * survives.
 */
export function autoUpdateInstallArgs(version: string): string[] {
    return ['i', '-g', '--allow-scripts=very-happy-cli,node-pty', `very-happy-cli@${version}`];
}
