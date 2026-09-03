/**
 * B-321 — do not hand the machine over to a bundle that cannot run.
 *
 * The self-handover releases the daemon state, the lock and the socket BEFORE
 * spawning its replacement, and then exits unconditionally — a spawn failure is
 * a `logger.debug` line and nothing else. So a bundle that npm left in a broken
 * state took the machine offline silently, with no rollback and no report. And
 * because a handed-over daemon runs outside launchd, nothing brings it back:
 * KeepAlive is not watching it. That is a person-goes-and-fixes-it outage, and
 * the user's only symptom is "my machine went offline".
 *
 * This is not hypothetical. Production has already seen npm leave a half-written
 * tree — `package.json` on the new version, `node_modules` mixed, the CLI itself
 * crashing on `--version` — recoverable only by deleting the tree and
 * reinstalling (docs/operations.md, "Web cache safety" incident notes).
 *
 * So: run the new bundle first. `--version` is the same smoke the release
 * process already mandates for exactly this class of breakage (iron rule 2:
 * a green build is not a running binary), it is cheap, and it exercises the
 * module graph and the native addons that a half-install breaks.
 *
 * A failed preflight is not fatal — the daemon simply keeps serving on the code
 * it already has and reports why. The mtime watcher fires again on the next
 * heartbeat, so a genuinely-finished install is picked up moments later.
 */
export type HandoverPreflight =
    | { action: 'handover' }
    | { action: 'hold'; reason: string };

export interface PreflightRun {
    exitCode: number | null;
    stdout: string;
    timedOut: boolean;
    spawnError?: string;
}

/** Matches the `very-happy version: X.Y.Z` line the CLI prints. */
const VERSION_RE = /very-happy version:\s*(\d+\.\d+\.\d+[^\s]*)/i;

export function decideHandover(run: PreflightRun): HandoverPreflight {
    if (run.spawnError) return { action: 'hold', reason: `new bundle could not be started: ${run.spawnError}` };
    if (run.timedOut) return { action: 'hold', reason: 'new bundle did not answer --version within the timeout' };
    if (run.exitCode !== 0) return { action: 'hold', reason: `new bundle exited ${run.exitCode} on --version` };
    if (!VERSION_RE.test(run.stdout)) {
        return { action: 'hold', reason: 'new bundle printed no recognisable version' };
    }
    return { action: 'handover' };
}

export function preflightVersion(stdout: string): string | null {
    return stdout.match(VERSION_RE)?.[1] ?? null;
}
