/**
 * B-956: find npm-installed agent CLIs (dsh, pi + pi-acp, gemini) that are not
 * on the daemon's own PATH, without blocking the daemon's main thread.
 *
 * The daemon's PATH is a snapshot of whichever shell (or service manager)
 * started it. A CLI installed afterwards with `npm install -g` under another
 * Node — nvm / fnm / mise / asdf keep one global bin dir per Node version, and
 * only the shell's current one is on PATH — is invisible to it, so the
 * launcher said 「未安装」 until the user restarted the daemon from the right
 * terminal. Here the daemon also looks in its login shell's PATH and in the
 * version managers' install dirs, remembers the dir it found the CLI in, and
 * spawns that agent's wrapper with the dir in front of PATH: the CLI then runs
 * exactly like in the user's terminal, on the `node` installed next to it
 * (the `#!/usr/bin/env node` scripts pick the first `node` on PATH).
 *
 * Every probe is async (fs/promises, one login-shell spawn, `node --version`
 * via execFile); the daemon calls this from the throttled keep-alive.
 */
import { execFile } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import { delimiter, join } from 'node:path';
import { probeLoginShellEnv } from '@/agentHome/loginShellEnv';
import { nodeMeetsDshMinimum, parseNodeVersion } from '@/agent/acp/dshRunner';

/** The agents whose executables are resolved here, and the commands each needs. */
export const RESOLVED_AGENT_COMMANDS = {
    dsh: ['dsh'],
    pi: ['pi', 'pi-acp'],
    gemini: ['gemini'],
} as const;
export type ResolvedAgent = keyof typeof RESOLVED_AGENT_COMMANDS;

export { AGENT_SEARCH_LOCATIONS } from '@/utils/agentSearchLocations';

export interface AgentBinProbes {
    /** true when `path` is an executable file. */
    isExecutable(path: string): Promise<boolean>;
    /** Entries of `dir`; [] when it does not exist. */
    listDir(dir: string): Promise<string[]>;
    /** `<node> --version`, null when it does not answer. */
    nodeVersion(nodePath: string): Promise<string | null>;
    /** The login shell's PATH, null when it could not be asked. */
    loginShellPath(): Promise<string | null>;
}

export interface AgentBinContext {
    home: string;
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
}

export interface ResolvedDsh {
    /** Dir holding `dsh`; null when it was not found anywhere. */
    dir: string | null;
    /** `node --version` of the node that dsh runs on from `dir`; null when there is none. */
    nodeVersion: string | null;
    /** Dirs to put in front of the wrapper's PATH ([] when the daemon's PATH already works). */
    extraPath: string[];
}

export interface ResolvedAgentBins {
    dsh: ResolvedDsh;
    /** Per agent: the dirs to prepend, or null when a command is missing everywhere. */
    pi: string[] | null;
    gemini: string[] | null;
}

function splitPath(value: string | undefined | null): string[] {
    return (value ?? '').split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}

/** Newest version dir first (`v24.9.0` before `v22.1.0`); unparsable names last. */
function sortVersionsDesc(names: string[]): string[] {
    return [...names].sort((a, b) => {
        const va = parseNodeVersion(a);
        const vb = parseNodeVersion(b);
        if (!va || !vb) return va ? -1 : vb ? 1 : a.localeCompare(b);
        for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return vb[i] - va[i];
        return 0;
    });
}

/**
 * The dirs a version manager installs global npm executables into, newest
 * Node first. Only existing ones are returned.
 */
export async function versionManagerBinDirs(ctx: AgentBinContext, probes: Pick<AgentBinProbes, 'listDir'>): Promise<string[]> {
    const { home, env } = ctx;
    const perVersion: Array<{ root: string; suffix: string[] }> = [
        { root: join(env.NVM_DIR || join(home, '.nvm'), 'versions', 'node'), suffix: ['bin'] },
        ...[env.FNM_DIR, join(home, '.local', 'share', 'fnm'), join(home, '.fnm'), join(home, 'Library', 'Application Support', 'fnm')]
            .filter((dir): dir is string => !!dir)
            .map((dir) => ({ root: join(dir, 'node-versions'), suffix: ['installation', 'bin'] })),
        { root: join(env.MISE_DATA_DIR || join(home, '.local', 'share', 'mise'), 'installs', 'node'), suffix: ['bin'] },
        { root: join(env.ASDF_DATA_DIR || join(home, '.asdf'), 'installs', 'nodejs'), suffix: ['bin'] },
    ];
    const dirs: string[] = [];
    for (const { root, suffix } of perVersion) {
        for (const version of sortVersionsDesc(await probes.listDir(root))) {
            dirs.push(join(root, version, ...suffix));
        }
    }
    // Volta keeps one shim dir that picks the right Node itself.
    dirs.push(join(env.VOLTA_HOME || join(home, '.volta'), 'bin'));
    return [...new Set(dirs)];
}

/** Daemon PATH first, then the login shell's, then the version-manager dirs. */
async function searchDirs(ctx: AgentBinContext, probes: AgentBinProbes): Promise<{ daemon: string[]; extra: string[]; loginShell: string[] }> {
    const daemon = splitPath(ctx.env.PATH);
    const loginShell = splitPath(await probes.loginShellPath());
    const managers = await versionManagerBinDirs(ctx, probes);
    const seen = new Set(daemon);
    const extra: string[] = [];
    for (const dir of [...loginShell, ...managers]) {
        if (seen.has(dir)) continue;
        seen.add(dir);
        extra.push(dir);
    }
    return { daemon, extra, loginShell };
}

async function findIn(dirs: string[], command: string, probes: AgentBinProbes): Promise<string[]> {
    const hits: string[] = [];
    for (const dir of dirs) {
        if (await probes.isExecutable(join(dir, command))) hits.push(dir);
    }
    return hits;
}

/**
 * The dsh to start: the first copy (daemon PATH, then the other dirs) whose
 * `node` is new enough. A dsh dir's node is the one next to it (nvm/fnm/mise
 * put `node` and the global executables in the same bin), else the first
 * `node` on the login shell's PATH, else the daemon's. When no copy has a new
 * enough Node, the first copy found is reported with its Node so the message
 * can say which one is too old.
 */
async function resolveDsh(dirs: { daemon: string[]; extra: string[]; loginShell: string[] }, probes: AgentBinProbes): Promise<ResolvedDsh> {
    const daemonHits = await findIn(dirs.daemon, 'dsh', probes);
    const extraHits = await findIn(dirs.extra, 'dsh', probes);
    let first: ResolvedDsh | null = null;
    for (const dir of [...daemonHits.slice(0, 1), ...extraHits]) {
        const onDaemonPath = dir === daemonHits[0];
        const nodeSearch = onDaemonPath ? dirs.daemon : [dir, ...dirs.loginShell, ...dirs.daemon];
        const nodeDir = (await findIn(nodeSearch, 'node', probes))[0] ?? null;
        const version = nodeDir ? await probes.nodeVersion(join(nodeDir, 'node')) : null;
        const extraPath = onDaemonPath ? [] : [...new Set([dir, ...(nodeDir && nodeDir !== dir ? [nodeDir] : [])])];
        const candidate: ResolvedDsh = { dir, nodeVersion: version, extraPath };
        if (nodeMeetsDshMinimum(version)) return candidate;
        first ??= candidate;
    }
    return first ?? { dir: null, nodeVersion: null, extraPath: [] };
}

/** Dirs to prepend so every command resolves; [] when all are on the daemon PATH, null when one is missing. */
async function resolveCommands(commands: readonly string[], dirs: { daemon: string[]; extra: string[] }, probes: AgentBinProbes): Promise<string[] | null> {
    const extraPath: string[] = [];
    for (const command of commands) {
        if ((await findIn(dirs.daemon, command, probes)).length > 0) continue;
        const hit = (await findIn(dirs.extra, command, probes))[0];
        if (!hit) return null;
        if (!extraPath.includes(hit)) extraPath.push(hit);
    }
    return extraPath;
}

export async function resolveAgentBins(ctx: AgentBinContext, probes: AgentBinProbes): Promise<ResolvedAgentBins> {
    const dirs = await searchDirs(ctx, probes);
    return {
        dsh: await resolveDsh(dirs, probes),
        pi: await resolveCommands(RESOLVED_AGENT_COMMANDS.pi, dirs, probes),
        gemini: await resolveCommands(RESOLVED_AGENT_COMMANDS.gemini, dirs, probes),
    };
}

// ── real probes ─────────────────────────────────────────────────────────────

export const defaultAgentBinProbes: AgentBinProbes = {
    async isExecutable(path) {
        try {
            await access(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
            return true;
        } catch {
            return false;
        }
    },
    async listDir(dir) {
        try {
            return await readdir(dir);
        } catch {
            return [];
        }
    },
    nodeVersion(nodePath) {
        return new Promise((resolve) => {
            execFile(nodePath, ['--version'], { encoding: 'utf8', timeout: 3000, windowsHide: true }, (error, stdout) => {
                resolve(error ? null : (stdout.trim() || null));
            });
        });
    },
    async loginShellPath() {
        const env = await probeLoginShellEnv(['PATH']);
        return env?.PATH ?? null;
    },
};

// ── what the daemon remembers between probes ────────────────────────────────

let lastResolved: ResolvedAgentBins | null = null;

export function rememberAgentBins(resolved: ResolvedAgentBins): void {
    lastResolved = resolved;
}

/** The dirs the last probe found `agent`'s executables in, outside the daemon's PATH. */
export function agentExtraPath(agent: string | undefined): string[] {
    if (!lastResolved) return [];
    if (agent === 'dsh') return lastResolved.dsh.extraPath;
    if (agent === 'pi') return lastResolved.pi ?? [];
    if (agent === 'gemini') return lastResolved.gemini ?? [];
    return [];
}

/**
 * The env var the daemon hands an agent's wrapper: the dirs to put in front of
 * PATH for the agent CLI only. The wrapper itself keeps the daemon's PATH (it
 * finds its own `node` there; an old Node from nvm must not run Very Happy).
 */
export const AGENT_PATH_PREPEND_ENV = 'VH_AGENT_PATH_PREPEND';

/** `{ VH_AGENT_PATH_PREPEND }` to spread into a wrapper's env, or `{}`. */
export function agentSpawnPathEnv(agent: string | undefined): Record<string, string> {
    const extra = agentExtraPath(agent);
    return extra.length > 0 ? { [AGENT_PATH_PREPEND_ENV]: extra.join(delimiter) } : {};
}

/** Agents whose CLI may live outside the daemon's PATH (see agentExtraPath). */
const PATH_RESOLVED_AGENTS = new Set(['dsh', 'pi', 'gemini']);

/**
 * B-958: agentSpawnPathEnv for a relaunch (resume / restart). Those run without
 * the fresh-spawn availability gate, and the first probe only runs on the
 * daemon's first keep-alive tick — so when nothing has been probed yet, probe
 * once (`recheck`) before reading the remembered dirs.
 */
export async function relaunchAgentPathEnv(
    agent: string | undefined,
    recheck: (() => Promise<void>) | undefined,
): Promise<Record<string, string>> {
    if (!lastResolved && recheck && agent && PATH_RESOLVED_AGENTS.has(agent)) {
        try {
            await recheck();
        } catch {
            // Best effort: spawn with what we have (the wrapper reports ENOENT).
        }
    }
    return agentSpawnPathEnv(agent);
}

/**
 * Wrapper side: the env for the agent CLI child process — the daemon's dirs in
 * front of PATH (Node resolves the command with the child env's PATH), the
 * hand-off variable removed. Unchanged when there is nothing to prepend.
 */
export function agentChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const extra = splitPath(env[AGENT_PATH_PREPEND_ENV]);
    if (extra.length === 0) return env;
    const next = { ...env };
    delete next[AGENT_PATH_PREPEND_ENV];
    next.PATH = [...extra, ...splitPath(env.PATH).filter((dir) => !extra.includes(dir))].join(delimiter);
    return next;
}

export function defaultAgentBinContext(): AgentBinContext {
    return { home: os.homedir(), env: process.env, platform: process.platform };
}

/** Test hook. */
export function resetRememberedAgentBins(): void {
    lastResolved = null;
}
