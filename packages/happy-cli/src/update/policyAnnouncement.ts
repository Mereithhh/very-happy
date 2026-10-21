/**
 * B-718 — the relay announces "the promoted CLI changed" so an idle machine
 * installs it within minutes instead of on its next hourly policy check.
 *
 * The announcement is only a hint to re-read `/v1/version/cli` early. It never
 * names what to install: the daemon re-fetches the policy over REST and every
 * existing gate (enabled, idle, promote-only target, one attempt per version,
 * B-321 handover) decides exactly as on the hourly check. An old relay never
 * sends it and an old daemon ignores it, so the hourly check stays the
 * fallback in both directions.
 *
 * Timing: the relay notices a promote within its 60 s registry cache, and the
 * policy response itself may be cached for up to 60 s more (CloudFront honours
 * its `max-age=60`). The first re-read therefore waits 90–150 s — which also
 * spreads a fleet's npm installs — and, if the policy still does not show the
 * announced version, one follow-up re-read runs five minutes later.
 */
import { parseExactVersion } from './cliUpdate';

export const ANNOUNCE_FIRST_DELAY_MS = 90_000;
export const ANNOUNCE_JITTER_MS = 60_000;
export const ANNOUNCE_FOLLOW_UP_MS = 5 * 60_000;

/** Validates the relay's payload. Anything that is not `{ autoUpdateVersion: <exact semver> }` is ignored. */
export function announcedVersion(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const raw = (payload as { autoUpdateVersion?: unknown }).autoUpdateVersion;
    if (typeof raw !== 'string' || raw.length > 64) return null;
    return parseExactVersion(raw)?.exact ?? null;
}

export interface PolicyAnnouncementDependencies {
    /** Re-read the relay policy and evaluate it (updateController.refresh). */
    refresh: () => Promise<void>;
    /** The autoUpdateVersion the daemon currently holds, or null. */
    currentTarget: () => string | null;
    random?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

export function createPolicyAnnouncementHandler(deps: PolicyAnnouncementDependencies) {
    const random = deps.random ?? Math.random;
    const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let timer: unknown = null;
    let pending: string | null = null;
    let stopped = false;

    function schedule(version: string, ms: number, followUp: boolean) {
        if (timer !== null) clearTimer(timer);
        pending = version;
        timer = setTimer(() => {
            timer = null;
            void deps.refresh().catch(() => undefined).finally(() => {
                if (stopped || pending !== version) return;
                if (deps.currentTarget() === version || !followUp) { pending = null; return; }
                schedule(version, ANNOUNCE_FOLLOW_UP_MS, false);
            });
        }, ms);
    }

    return {
        /** Socket handler. Returns the scheduled delay (ms) or null when ignored — for logs and tests. */
        onAnnouncement(payload: unknown): number | null {
            if (stopped) return null;
            const version = announcedVersion(payload);
            if (!version || version === deps.currentTarget() || version === pending) return null;
            const delay = ANNOUNCE_FIRST_DELAY_MS + Math.floor(random() * ANNOUNCE_JITTER_MS);
            schedule(version, delay, true);
            return delay;
        },
        stop() {
            stopped = true;
            if (timer !== null) clearTimer(timer);
            timer = null;
        },
    };
}
