/**
 * Agent home directories (B-478) — where Claude Code and Codex keep their
 * conversations on THIS machine.
 *
 * Claude reads `$CLAUDE_CONFIG_DIR` (default `~/.claude`) and Codex reads
 * `$CODEX_HOME` (default `~/.codex`). The daemon used to take whatever
 * `process.env` it was started with — a snapshot of the shell that ran
 * `daemon start`, kept alive across every handover — so a user who later
 * moved the directories (typical on a dev box whose home is wiped on reset:
 * `export CLAUDE_CONFIG_DIR=/mnt/data/.claude` in `.bashrc`) could still run
 * `claude --resume <id>` by hand, while every daemon resume looked in
 * `~/.claude`, found nothing, and opened a fresh conversation.
 *
 * Everything here is pure: the daemon feeds in settings, its own env, what the
 * user's login shell exports and a file-exists probe; nothing touches disk.
 *
 * Precedence, highest first:
 *   1. machine-local settings (`claudeConfigDir` / `codexHome` in settings.json)
 *      — the explicit override for the rare machine whose login shell is wrong;
 *   2. the user's login shell — what `claude --resume` in their terminal sees;
 *   3. the daemon's own environment — a service manager may set it deliberately;
 *   4. the provider default.
 */
import { join, resolve, isAbsolute } from 'node:path';

export type AgentHomeSource = 'settings' | 'login-shell' | 'daemon-env' | 'default';

export interface AgentHomeChoice {
    path: string;
    source: AgentHomeSource;
}

export interface AgentHomes {
    claudeConfigDir: AgentHomeChoice;
    codexHome: AgentHomeChoice;
}

export interface AgentHomeSettings {
    claudeConfigDir?: string;
    codexHome?: string;
}

export type EnvLike = Record<string, string | undefined>;

export interface ResolveAgentHomesInput {
    settings: AgentHomeSettings;
    daemonEnv: EnvLike;
    /** `null` when the login shell could not be probed (timeout, Windows, …). */
    loginShellEnv: EnvLike | null;
    homeDir: string;
}

export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
export const CODEX_HOME_ENV = 'CODEX_HOME';
export const AGENT_HOME_ENV_NAMES = [CLAUDE_CONFIG_DIR_ENV, CODEX_HOME_ENV] as const;

/** `~` and `~/x` expand against the daemon user's home; relative paths resolve
 *  against it too (a relative CLAUDE_CONFIG_DIR is meaningless for a daemon
 *  whose cwd is `/`). */
export function expandHomePath(value: string, homeDir: string): string {
    const trimmed = value.trim();
    if (trimmed === '~') return homeDir;
    if (trimmed.startsWith('~/')) return join(homeDir, trimmed.slice(2));
    return isAbsolute(trimmed) ? trimmed : resolve(homeDir, trimmed);
}

function nonEmpty(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

function pick(
    envName: string,
    settingValue: string | undefined,
    input: ResolveAgentHomesInput,
    defaultRelative: string,
): AgentHomeChoice {
    const fromSettings = nonEmpty(settingValue);
    if (fromSettings) return { path: expandHomePath(fromSettings, input.homeDir), source: 'settings' };
    const fromShell = nonEmpty(input.loginShellEnv?.[envName]);
    if (fromShell) return { path: expandHomePath(fromShell, input.homeDir), source: 'login-shell' };
    const fromDaemon = nonEmpty(input.daemonEnv[envName]);
    if (fromDaemon) return { path: expandHomePath(fromDaemon, input.homeDir), source: 'daemon-env' };
    return { path: join(input.homeDir, defaultRelative), source: 'default' };
}

export function resolveAgentHomes(input: ResolveAgentHomesInput): AgentHomes {
    return {
        claudeConfigDir: pick(CLAUDE_CONFIG_DIR_ENV, input.settings.claudeConfigDir, input, '.claude'),
        codexHome: pick(CODEX_HOME_ENV, input.settings.codexHome, input, '.codex'),
    };
}

/**
 * The env overlay a spawn (or the daemon's own `process.env`) should carry so
 * `getProjectPath`, the Claude SDK, `codex app-server` and the sandbox deny
 * list all agree on one directory. A `default` choice sets nothing: the
 * provider computes the same path itself and an unset variable stays unset.
 */
export function agentHomeEnv(homes: AgentHomes): Record<string, string> {
    const env: Record<string, string> = {};
    if (homes.claudeConfigDir.source !== 'default') env[CLAUDE_CONFIG_DIR_ENV] = homes.claudeConfigDir.path;
    if (homes.codexHome.source !== 'default') env[CODEX_HOME_ENV] = homes.codexHome.path;
    return env;
}

/** Same encoding as `getProjectPath` (Claude Code replaces every char outside
 *  `[a-zA-Z0-9-]` with `-`), kept here so discovery never depends on
 *  `process.env` the way `getProjectPath` does. */
export function claudeProjectDirName(workingDirectory: string): string {
    return resolve(workingDirectory).replace(/[^a-zA-Z0-9-]/g, '-');
}

export function claudeConversationPath(configDir: string, workingDirectory: string, claudeSessionId: string): string {
    return join(configDir, 'projects', claudeProjectDirName(workingDirectory), `${claudeSessionId}.jsonl`);
}

/**
 * Every directory worth checking for a conversation, most likely first and
 * without duplicates: the resolved choice, then each other source, then the
 * provider default. The resolved directory is always first so a hit there
 * never changes the spawn env.
 */
export function agentHomeCandidates(
    kind: 'claude' | 'codex',
    input: ResolveAgentHomesInput,
    homes: AgentHomes = resolveAgentHomes(input),
): string[] {
    const envName = kind === 'claude' ? CLAUDE_CONFIG_DIR_ENV : CODEX_HOME_ENV;
    const resolved = kind === 'claude' ? homes.claudeConfigDir : homes.codexHome;
    const raw: Array<string | null | undefined> = [
        resolved.path,
        nonEmpty(kind === 'claude' ? input.settings.claudeConfigDir : input.settings.codexHome),
        nonEmpty(input.loginShellEnv?.[envName]),
        nonEmpty(input.daemonEnv[envName]),
        join(input.homeDir, kind === 'claude' ? '.claude' : '.codex'),
    ];
    const out: string[] = [];
    for (const value of raw) {
        if (!value) continue;
        const expanded = expandHomePath(value, input.homeDir);
        if (!out.includes(expanded)) out.push(expanded);
    }
    return out;
}

export interface ConversationHit {
    /** The home directory that holds the conversation. */
    home: string;
    file: string;
    /** `true` when `home` is the resolved directory — nothing to override. */
    resolved: boolean;
}

/**
 * Locate `<home>/projects/<cwd>/<id>.jsonl` across the candidates. `fileSize`
 * returns the byte size, or `null` when the file is absent. When more than one
 * candidate has the file, the LARGEST wins (ties → earlier candidate): Claude
 * Code leaves a few-hundred-byte stub behind in the directory a stopped
 * process was using (seen 2026-09-22: a 285-byte `<id>.jsonl` in `~/.claude`
 * next to the 180 KB real transcript in the moved directory), and resuming the
 * stub loses the conversation. `resolved` tells the caller whether the spawn
 * needs a `CLAUDE_CONFIG_DIR` override to make Claude look in the same place.
 */
export function findClaudeConversation(
    claudeSessionId: string,
    workingDirectory: string,
    candidates: string[],
    fileSize: (path: string) => number | null,
): ConversationHit | null {
    let best: ConversationHit | null = null;
    let bestSize = -1;
    for (let i = 0; i < candidates.length; i++) {
        const file = claudeConversationPath(candidates[i], workingDirectory, claudeSessionId);
        const size = fileSize(file);
        if (size === null || size <= bestSize) continue;
        best = { home: candidates[i], file, resolved: i === 0 };
        bestSize = size;
    }
    return best;
}

/** Codex rollouts live at `<home>/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`. */
export function codexRolloutFileMatches(fileName: string, threadId: string): boolean {
    return fileName.startsWith('rollout-') && fileName.endsWith(`-${threadId}.jsonl`);
}

/**
 * Locate a Codex thread across the candidates. `listDir` returns the entries
 * of a directory (or `[]` when it does not exist); the walk is bounded to the
 * three date levels so a stray huge directory cannot stall a spawn.
 */
export function findCodexThread(
    threadId: string,
    candidates: string[],
    listDir: (path: string) => string[],
): ConversationHit | null {
    const digits = /^\d+$/;
    for (let i = 0; i < candidates.length; i++) {
        const sessions = join(candidates[i], 'sessions');
        for (const year of listDir(sessions).filter(name => digits.test(name)).sort().reverse()) {
            for (const month of listDir(join(sessions, year)).filter(name => digits.test(name)).sort().reverse()) {
                for (const day of listDir(join(sessions, year, month)).filter(name => digits.test(name)).sort().reverse()) {
                    const dayDir = join(sessions, year, month, day);
                    const hit = listDir(dayDir).find(name => codexRolloutFileMatches(name, threadId));
                    if (hit) return { home: candidates[i], file: join(dayDir, hit), resolved: i === 0 };
                }
            }
        }
    }
    return null;
}

/** One line for logs / doctor: `~/.claude (login shell)`. */
export function describeAgentHome(choice: AgentHomeChoice): string {
    const source: Record<AgentHomeSource, string> = {
        settings: 'settings.json',
        'login-shell': 'login shell',
        'daemon-env': 'daemon environment',
        default: 'default',
    };
    return `${choice.path} (${source[choice.source]})`;
}
