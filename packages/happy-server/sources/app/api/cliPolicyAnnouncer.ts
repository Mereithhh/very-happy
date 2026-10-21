/**
 * B-718 — tell connected daemons when the promoted CLI changes.
 *
 * Before this, a promote reached a machine on its next hourly policy check
 * (measured on 0.2.179: 52 minutes on an idle Mac). The relay already resolves
 * npm `latest` every 60 s for `/v1/version/cli`; this watches that same answer
 * and, when the install target moves, emits `cli-update-policy` to every
 * machine-scoped socket. The payload is a hint, not an instruction: the daemon
 * re-reads `/v1/version/cli` and applies all of its own gates (enabled, idle,
 * promote-only, one attempt per version). Old daemons ignore the event; the
 * hourly check remains the fallback.
 */
export const ANNOUNCER_INTERVAL_MS = 60_000;

/** The version to announce, or null. The first answer after start is a baseline, never an announcement. */
export function versionToAnnounce(known: string | null | undefined, next: string | null): string | null {
    if (known === undefined || !next || next === known) return null;
    return next;
}

export interface CliPolicyAnnouncerDependencies {
    current: () => Promise<{ autoUpdateVersion: string | null; source: string }>;
    emit: (payload: { autoUpdateVersion: string }) => void;
    log?: (message: string) => void;
    intervalMs?: number;
}

export function startCliPolicyAnnouncer(deps: CliPolicyAnnouncerDependencies): { check: () => Promise<string | null>; stop: () => void } {
    let known: string | null | undefined;
    let running = false;
    async function check(): Promise<string | null> {
        if (running) return null;
        running = true;
        try {
            const policy = await deps.current();
            // An unreachable registry keeps the last answer; it is not a change.
            if (policy.source === 'unavailable') return null;
            const announce = versionToAnnounce(known, policy.autoUpdateVersion);
            if (policy.autoUpdateVersion) known = policy.autoUpdateVersion;
            else if (known === undefined) known = null;
            if (announce) {
                deps.emit({ autoUpdateVersion: announce });
                deps.log?.(`Announced promoted CLI ${announce} to connected daemons`);
            }
            return announce;
        } catch {
            return null;
        } finally {
            running = false;
        }
    }
    void check();
    const timer = setInterval(() => void check(), deps.intervalMs ?? ANNOUNCER_INTERVAL_MS);
    timer.unref?.();
    return { check, stop: () => clearInterval(timer) };
}
