/**
 * B-512: the bundle smoke test behind `very-happy --version` (and its hidden
 * alias `--self-check`): import every lazily loaded module and the native
 * addons behind them, then print `very-happy version: X` (the handover
 * preflight parses it). Exit code 0 only when everything loaded. No auth, no
 * network, no daemon, no subcommand runs.
 */
import packageJson from '../package.json';
import { LAZY_MODULES } from './lazyModules';

export type SelfCheckFailure = { name: string; error: string };

export async function runSelfCheck(
    modules: ReadonlyArray<readonly [string, () => Promise<unknown>]> = LAZY_MODULES,
): Promise<SelfCheckFailure[]> {
    const failures: SelfCheckFailure[] = [];
    // Sequential: a failure names the module that broke, not a race winner.
    for (const [name, load] of modules) {
        try {
            await load();
        } catch (error) {
            failures.push({ name, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return failures;
}

/** `verbose` (the `--self-check` spelling) adds a summary line; `--version` prints only the version. */
export async function selfCheckMain(opts: { verbose?: boolean } = {}): Promise<number> {
    const started = Date.now();
    const failures = await runSelfCheck();
    if (failures.length > 0) {
        for (const failure of failures) {
            console.error(`very-happy: failed to load ${failure.name}: ${failure.error}`);
        }
        return 1;
    }
    if (opts.verbose) console.log(`self-check: ${LAZY_MODULES.length} modules loaded in ${Date.now() - started}ms`);
    console.log(`very-happy version: ${packageJson.version}`);
    return 0;
}
