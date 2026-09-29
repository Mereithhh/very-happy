/**
 * B-512: `very-happy --self-check` — import every lazily loaded module and the
 * native addons behind them, then print the same `very-happy version: X` line
 * as `--version` (the handover preflight parses it). Exit code 0 only when
 * everything loaded. No auth, no network, no daemon, no subcommand runs.
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

export async function selfCheckMain(): Promise<number> {
    const started = Date.now();
    const failures = await runSelfCheck();
    if (failures.length > 0) {
        for (const failure of failures) {
            console.error(`self-check: failed to load ${failure.name}: ${failure.error}`);
        }
        return 1;
    }
    console.log(`self-check: ${LAZY_MODULES.length} modules loaded in ${Date.now() - started}ms`);
    console.log(`very-happy version: ${packageJson.version}`);
    return 0;
}
