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
import { access, constants, lstat, readFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { isHarnessInstallId, type HarnessInstallId, type HarnessInstallState } from '@slopus/happy-wire';
import { globalPrefixForPackage } from '@/update/installLocation';
import { HARNESS_INSTALL_CATALOG, harnessInstallArgs, nodeSatisfies } from './installCatalog';
import type { NpmResult } from '@/update/npmInstall';
import { probeAgentVersion, stableVersion } from '@/daemon/agentVersions';

export type HarnessInstallRequestResult =
    | { accepted: true; harness: HarnessInstallId }
    | { error: 'node_too_old'; required: string; current: string }
    | { error: string };

/** Who asked for an install (log wording only; the RPC path is always the owner). */
export type HarnessInstallRequester = 'owner' | 'auto-update';

export interface HarnessInstallerDependencies {
    npm: (args: string[]) => Promise<NpmResult>;
    /** Package directory of the running CLI (projectPath()). */
    runningPackageDir: string;
    /** Whether `command` resolves on the daemon's PATH now. */
    commandOnPath: (command: string) => boolean;
    /** The CLI's own npm install, or its handover preflight, is in flight. */
    cliUpdateBusy: () => boolean;
    /** The Node running the daemon (and the harness it installs). Default process.versions.node. */
    nodeVersion?: string;
    publish: (state: HarnessInstallState) => void;
    /** Re-probe CLI availability and agent versions so the Web enables the harness. */
    afterInstall: () => Promise<void>;
    log: (message: string) => void;
    /**
     * B-931: after npm, the version the command on the daemon's PATH (the one a
     * session will start) really reports, against the version npm put in the
     * prefix. Returns the failure detail, or null when they agree.
     */
    verifyInstalled?: (harness: HarnessInstallId, prefix: string) => Promise<string | null>;
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

/** Strips credentials (npmrc auth keys, bearer tokens, URL userinfo) and home paths. */
export function redactNpmText(text: string): string {
    return text
        .replace(/(_authToken|_auth|_password|token|password)\s*=\s*\S+/gi, '$1=***')
        .replace(/Bearer\s+\S+/gi, 'Bearer ***')
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(:[^\s/@]*)?@/gi, '$1***@')
        .replace(/\/(home|Users)\/[^/\s]+/g, '~')
        .replace(/\/root(?=\/|\s|$)/g, '~');
}

/** npm's last lines without anything that looks like a token or a home path. */
export function summarizeNpmFailure(result: NpmResult): string {
    const tail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().split('\n').filter((line) => /npm (error|ERR!)|EACCES|ENOTFOUND|ETARGET|E404|engine/i.test(line)).slice(-3).join(' | ');
    const code = result.code === null ? 'npm_timeout' : `npm_exit_${result.code}`;
    const safe = redactNpmText(tail).slice(0, 300);
    return safe ? `${code}: ${safe}` : code;
}

/** B-931: the package whose version a harness's main command reports. */
export const HARNESS_VERSION_CHECK: Readonly<Record<HarnessInstallId, { package: string; command: string }>> = Object.freeze({
    claude: { package: '@anthropic-ai/claude-code', command: 'claude' },
    codex: { package: '@openai/codex', command: 'codex' },
    gemini: { package: '@google/gemini-cli', command: 'gemini' },
    pi: { package: '@earendil-works/pi-coding-agent', command: 'pi' },
});

/**
 * B-931: what npm installed vs what the session will run. `installed` = the
 * prefix's package.json, `running` = `<command> --version` on the daemon's
 * PATH, `resolved` = which file that was. Null = agrees.
 */
export function installVerificationFailure(command: string, facts: { installed: string | null; running: string | null; resolved: string | null }): string | null {
    const where = facts.resolved ? ` (${redactNpmText(facts.resolved)})` : '';
    if (!facts.installed) return `version_unverified: no ${command} package in the install prefix`;
    if (!facts.running) return `version_unverified: ${command} --version${where} gave no version`;
    if (facts.running !== facts.installed) return `version_mismatch: ${command} on PATH${where} runs ${facts.running}, installed ${facts.installed}`;
    return null;
}

/** First `command` on `path` that is an executable file (POSIX lookup order). */
export async function resolveOnPath(command: string, path: string | undefined = process.env.PATH, canExec = defaultCanExec): Promise<string | null> {
    for (const dir of (path ?? '').split(delimiter)) {
        if (!dir) continue;
        const candidate = join(dir, command);
        if (await canExec(candidate)) return candidate;
    }
    return null;
}
async function defaultCanExec(path: string): Promise<boolean> {
    try { await access(path, constants.X_OK); return true; } catch { return false; }
}

export async function defaultVerifyInstalled(harness: HarnessInstallId, prefix: string): Promise<string | null> {
    const check = HARNESS_VERSION_CHECK[harness];
    let installed: string | null = null;
    try {
        const pkg = JSON.parse(await readFile(join(prefix, 'lib', 'node_modules', ...check.package.split('/'), 'package.json'), 'utf8')) as { version?: unknown };
        installed = typeof pkg.version === 'string' ? stableVersion(pkg.version) : null;
    } catch { installed = null; }
    const [probe, resolved] = await Promise.all([
        probeAgentVersion(check.command).catch(() => ({ version: null, missing: false })),
        process.platform === 'win32' ? Promise.resolve(null) : resolveOnPath(check.command),
    ]);
    return installVerificationFailure(check.command, { installed, running: probe.version, resolved });
}

export function createHarnessInstaller(deps: HarnessInstallerDependencies) {
    const now = deps.now ?? Date.now;
    const canWrite = deps.canWrite ?? defaultCanWrite;
    const isPlainDirectory = deps.isPlainDirectory ?? defaultIsPlainDirectory;
    let running: HarnessInstallId | null = null;
    // Like updateController's `blocked`: npm outlived its kill and may still be
    // writing the prefix, so neither another install nor the CLI's own update
    // may start until the daemon restarts.
    let blocked = false;
    const nodeVersion = deps.nodeVersion ?? process.versions.node;

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
            if (result.terminationConfirmed === false) {
                blocked = true;
                deps.log(`[HARNESS] ${harness} install timed out and npm could not be confirmed stopped; holding the npm tree until the daemon restarts`);
                publish('failed', 'installer_termination_unconfirmed');
                return;
            }
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
            // B-931: npm exit 0 is not "installed" — the binary a session starts must report what npm put there.
            const mismatch = await (deps.verifyInstalled ?? defaultVerifyInstalled)(harness, prefix)
                .catch((error) => `version_unverified: ${redactNpmText(String(error)).slice(0, 200)}`);
            await deps.afterInstall().catch((error) => deps.log(`[HARNESS] refresh after ${harness} install failed: ${String(error)}`));
            if (mismatch) {
                deps.log(`[HARNESS] ${harness} install not effective: ${mismatch}`);
                publish('failed', mismatch);
                return;
            }
            deps.log(`[HARNESS] ${harness} installed`);
            publish('installed');
        } catch (error) {
            deps.log(`[HARNESS] ${harness} install error: ${String(error)}`);
            publish('failed', 'install_error');
        } finally {
            if (!blocked) running = null;
        }
    }

    return {
        /** True while npm may be writing the prefix — including after an unconfirmed kill. */
        isRunning: () => running !== null || blocked,
        /** `requester` is only for the log: the machine page (owner) or B-894's agent auto-update. */
        async request(params: unknown, requester: HarnessInstallRequester = 'owner'): Promise<HarnessInstallRequestResult> {
            const harness = params && typeof params === 'object' ? (params as { harness?: unknown }).harness : undefined;
            if (!isHarnessInstallId(harness)) {
                deps.log(`[HARNESS] refused install request for an unknown harness`);
                return { error: 'unknown_harness' };
            }
            if (blocked) return { error: 'installer_blocked' };
            if (running) return { error: 'install_in_progress' };
            if (deps.cliUpdateBusy()) return { error: 'cli_update_in_progress' };
            const minNode = HARNESS_INSTALL_CATALOG[harness].minNode;
            if (!nodeSatisfies(nodeVersion, minNode)) {
                deps.log(`[HARNESS] ${harness} install refused: needs Node ${minNode}+, daemon runs ${nodeVersion}`);
                return { error: 'node_too_old', required: minNode, current: nodeVersion };
            }
            // Claim the fence BEFORE the first await: from here the CLI's own
            // update sees us as busy, so it cannot start between this check and npm.
            running = harness;
            const location = await installPrefix();
            if ('error' in location) {
                running = null;
                deps.log(`[HARNESS] ${harness} install refused: ${location.error}`);
                return location;
            }
            const startedAt = now();
            deps.log(`[HARNESS] ${requester === 'auto-update' ? 'agent auto-update' : 'owner'} requested ${harness} install`);
            deps.publish({ harness, state: 'installing', startedAt, at: startedAt });
            void run(harness, location.prefix, startedAt);
            return { accepted: true, harness };
        },
    };
}
