/**
 * B-719 — install or update a coding-agent CLI on this machine, only because
 * the owner clicked Install / Update for it in the Web.
 *
 * - The RPC carries a harness id; anything else is refused before npm runs.
 * - npm runs without a shell (runNpmProcess), into the global prefix this
 *   daemon itself runs from, and only if this user can write it. No sudo, no
 *   guessing another prefix: when the prefix is not ours to write, the Web is
 *   told why and shown the manual command instead.
 * - One install at a time, never while the CLI's own update is running (both
 *   write the same npm tree); the CLI's automatic update in turn waits for this.
 * - The RPC answers immediately (relay RPCs are capped at 30 s); progress and
 *   the outcome are published in daemonState.harnessInstall and logged.
 */
import { access, constants, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isHarnessInstallId, type HarnessInstallId, type HarnessInstallState } from '@slopus/happy-wire';
import { globalPrefixForPackage } from '@/update/installLocation';
import { HARNESS_INSTALL_CATALOG, harnessInstallArgs } from './installCatalog';
import type { NpmResult } from '@/update/npmInstall';

export type HarnessInstallRequestResult = { accepted: true; harness: HarnessInstallId } | { error: string };

export interface HarnessInstallerDependencies {
    npm: (args: string[]) => Promise<NpmResult>;
    /** Package directory of the running CLI (projectPath()). */
    runningPackageDir: string;
    /** Whether `command` resolves on the daemon's PATH now. */
    commandOnPath: (command: string) => boolean;
    /** The CLI's own npm install/handover is in flight. */
    cliUpdateBusy: () => boolean;
    publish: (state: HarnessInstallState) => void;
    /** Re-probe CLI availability and agent versions so the Web enables the harness. */
    afterInstall: () => Promise<void>;
    log: (message: string) => void;
    canWrite?: (path: string) => Promise<boolean>;
    isPlainDirectory?: (path: string) => Promise<boolean>;
    now?: () => number;
}

async function defaultCanWrite(path: string): Promise<boolean> {
    try { await access(path, constants.W_OK); return true; } catch { return false; }
}
async function defaultIsPlainDirectory(path: string): Promise<boolean> {
    try { const s = await lstat(path); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; }
}

/** npm's last lines without anything that looks like a token or a home path. */
export function summarizeNpmFailure(result: NpmResult): string {
    const tail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().split('\n').filter((line) => /npm (error|ERR!)|EACCES|ENOTFOUND|ETARGET|E404|engine/i.test(line)).slice(-3).join(' | ');
    const code = result.code === null ? 'npm_timeout' : `npm_exit_${result.code}`;
    const safe = tail.replace(/(_authToken|token|password)=\S+/gi, '$1=***').replace(/\/(home|Users)\/[^/\s]+/g, '~').slice(0, 300);
    return safe ? `${code}: ${safe}` : code;
}

export function createHarnessInstaller(deps: HarnessInstallerDependencies) {
    const now = deps.now ?? Date.now;
    const canWrite = deps.canWrite ?? defaultCanWrite;
    const isPlainDirectory = deps.isPlainDirectory ?? defaultIsPlainDirectory;
    let running: HarnessInstallId | null = null;

    /** Same rule as the CLI's own update (B-489): the prefix of the running package, writable by us. */
    async function installPrefix(): Promise<{ prefix: string } | { error: string }> {
        const prefix = globalPrefixForPackage(deps.runningPackageDir);
        if (!prefix || !await isPlainDirectory(deps.runningPackageDir)) return { error: 'install_location_unverified' };
        for (const path of [dirname(deps.runningPackageDir), join(prefix, 'bin')]) {
            if (!await canWrite(path)) return { error: 'install_location_not_writable' };
        }
        return { prefix };
    }

    async function run(harness: HarnessInstallId, prefix: string, startedAt: number) {
        const publish = (state: string, detail?: string) => deps.publish({ harness, state, ...(detail ? { detail } : {}), startedAt, at: now() });
        try {
            const args = harnessInstallArgs(harness, prefix);
            deps.log(`[HARNESS] installing ${harness}: npm ${args.join(' ')}`);
            const result = await deps.npm(args);
            if (result.code !== 0) {
                const detail = summarizeNpmFailure(result);
                deps.log(`[HARNESS] ${harness} install failed: ${detail}`);
                publish('failed', detail);
                return;
            }
            const missing = HARNESS_INSTALL_CATALOG[harness].commands.filter((command) => !deps.commandOnPath(command));
            if (missing.length > 0) {
                // npm wrote the files, but the daemon cannot start them: its PATH does not include <prefix>/bin.
                const detail = `not_on_path: ${missing.join(', ')}`;
                deps.log(`[HARNESS] ${harness} installed into ${prefix} but ${detail}`);
                publish('failed', detail);
                return;
            }
            await deps.afterInstall().catch((error) => deps.log(`[HARNESS] refresh after ${harness} install failed: ${String(error)}`));
            deps.log(`[HARNESS] ${harness} installed`);
            publish('installed');
        } catch (error) {
            deps.log(`[HARNESS] ${harness} install error: ${String(error)}`);
            publish('failed', 'install_error');
        } finally {
            running = null;
        }
    }

    return {
        isRunning: () => running !== null,
        async request(params: unknown): Promise<HarnessInstallRequestResult> {
            const harness = params && typeof params === 'object' ? (params as { harness?: unknown }).harness : undefined;
            if (!isHarnessInstallId(harness)) {
                deps.log(`[HARNESS] refused install request for an unknown harness`);
                return { error: 'unknown_harness' };
            }
            if (running) return { error: 'install_in_progress' };
            if (deps.cliUpdateBusy()) return { error: 'cli_update_in_progress' };
            const location = await installPrefix();
            if ('error' in location) {
                deps.log(`[HARNESS] ${harness} install refused: ${location.error}`);
                return location;
            }
            if (running) return { error: 'install_in_progress' };
            running = harness;
            const startedAt = now();
            deps.log(`[HARNESS] owner requested ${harness} install`);
            deps.publish({ harness, state: 'installing', startedAt, at: startedAt });
            void run(harness, location.prefix, startedAt);
            return { accepted: true, harness };
        },
    };
}
