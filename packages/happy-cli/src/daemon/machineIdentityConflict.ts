/**
 * B-297 — detect a `~/.happy` directory that was copied to a second machine.
 *
 * `machineId` is a `randomUUID()` written once into `~/.happy/settings.json`
 * (`src/ui/auth.ts`), so two hosts can only ever share one machine row if the
 * happy home directory itself was copied — cloning a cloud dev box from a
 * snapshot, or hand-copying `~/.happy` to skip re-authenticating.
 *
 * That state is silent today and looks exactly like the user report that
 * produced this module ("linking the second machine killed the first one"):
 * both daemons hold machine-scoped sockets for the same machine row, and
 * `getOrCreateMachine` never overwrites the metadata of an existing machine, so
 * the web keeps showing whichever host registered first. The same copy usually
 * carries `~/.claude/.credentials.json` along with it, and since Claude Code
 * rotates the OAuth refresh token on every refresh, the two machines then also
 * take turns invalidating each other's Claude login.
 *
 * We only report; the operator decides. Renaming a host is a legitimate reason
 * for `host` alone to differ, which is why that case is reported as `weak`.
 */

export interface MachineIdentityFacts {
    host?: unknown;
    platform?: unknown;
    homeDir?: unknown;
}

export interface MachineIdentityConflict {
    /** `strong` when something no rename can explain differs. */
    confidence: 'weak' | 'strong';
    fields: Array<'host' | 'platform' | 'homeDir'>;
    recorded: { host?: string; platform?: string; homeDir?: string };
    current: { host: string; platform: string; homeDir: string };
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The HAPPY_VARIANT=dev daemon registers as `<hostname>-dev` so it is visually
 * distinct in the machine list, but it shares `~/.happy` — and therefore the
 * machine id — with the stable daemon on the same box. Comparing the raw strings
 * would flag every dev start as a conflict.
 */
function bareHost(host: string): string {
    return host.endsWith('-dev') ? host.slice(0, -'-dev'.length) : host;
}

/**
 * @param recorded metadata the server already had for this machine id, or null
 *   when the machine row was created by this registration.
 */
export function detectMachineIdentityConflict(
    recorded: MachineIdentityFacts | null | undefined,
    current: { host: string; platform: string; homeDir: string },
): MachineIdentityConflict | null {
    if (!recorded) return null;
    const recordedFacts = { host: str(recorded.host), platform: str(recorded.platform), homeDir: str(recorded.homeDir) };
    const fields: MachineIdentityConflict['fields'] = [];
    // A field the old record never had is not evidence of anything.
    if (recordedFacts.host && bareHost(recordedFacts.host) !== bareHost(current.host)) fields.push('host');
    if (recordedFacts.platform && recordedFacts.platform !== current.platform) fields.push('platform');
    if (recordedFacts.homeDir && recordedFacts.homeDir !== current.homeDir) fields.push('homeDir');
    if (fields.length === 0) return null;
    const strong = fields.some((field) => field !== 'host');
    return { confidence: strong ? 'strong' : 'weak', fields, recorded: recordedFacts, current };
}

export function describeMachineIdentityConflict(conflict: MachineIdentityConflict): string {
    const diffs = conflict.fields
        .map((field) => `${field}: recorded=${conflict.recorded[field] ?? '?'} current=${conflict.current[field]}`)
        .join(', ');
    const cause = conflict.confidence === 'strong'
        ? 'This machine id is registered to a different machine — ~/.happy was almost certainly copied here.'
        : 'This machine id is registered under a different hostname. If you renamed this host, ignore this; otherwise ~/.happy was copied here.';
    return `${cause} Two daemons sharing one machine id fight over the same machine row, and a copied ~/.claude/.credentials.json makes them invalidate each other's Claude login. Fix: run 'very-happy auth login --force' on this machine (it mints a fresh machine id), then log in to Claude here separately with 'claude'. (${diffs})`;
}
