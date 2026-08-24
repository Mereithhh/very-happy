import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MIN_NODE_VERSION = '20.19.0';
export const SUPPORTED_NODE_LABEL = '20.19+ within 20.x, 22.13+ within 22.x, or 24+';
export const MIN_TMUX_ENV_MAJOR = 3;
export const MIN_TMUX_ENV_MINOR = 2;

export type ToolProbe = {
    command: 'tmux' | 'claude' | 'codex' | 'gemini' | 'opencode' | 'openclaw';
    available: boolean;
    version?: string;
};

export type RuntimeReadiness = {
    node: { version: string; supported: boolean };
    tmux: ToolProbe & { supportsSessionEnv: boolean };
    agents: ToolProbe[];
};

export type ClaudeCredentialSource =
    | 'Amazon Bedrock'
    | 'Google Vertex AI'
    | 'Microsoft Foundry'
    | 'ANTHROPIC_AUTH_TOKEN'
    | 'ANTHROPIC_API_KEY'
    | 'CLAUDE_CODE_OAUTH_TOKEN'
    | 'Claude apiKeyHelper'
    | 'Claude local credentials';

export type ClaudeCredentialReadiness = {
    configured: boolean;
    source?: ClaudeCredentialSource;
};

type Environment = Record<string, string | undefined>;

function enabled(value: string | undefined): boolean {
    return ['1', 'true', 'yes'].includes(value?.trim().toLowerCase() ?? '');
}

/**
 * Detect only the presence and category of Claude authentication configuration.
 * Secret values, profile names, paths, and settings contents never leave this
 * function. OS keychain-backed Claude credentials are intentionally not probed.
 */
export function resolveClaudeCredentialReadiness(
    env: Environment = process.env,
    fileExists: (path: string) => boolean = existsSync,
    readText: (path: string) => string = path => readFileSync(path, 'utf8'),
    userHome = homedir(),
): ClaudeCredentialReadiness {
    if (enabled(env.CLAUDE_CODE_USE_BEDROCK)) return { configured: true, source: 'Amazon Bedrock' };
    if (enabled(env.CLAUDE_CODE_USE_VERTEX)) return { configured: true, source: 'Google Vertex AI' };
    if (enabled(env.CLAUDE_CODE_USE_FOUNDRY)) return { configured: true, source: 'Microsoft Foundry' };
    if (env.ANTHROPIC_AUTH_TOKEN?.trim()) return { configured: true, source: 'ANTHROPIC_AUTH_TOKEN' };
    if (env.ANTHROPIC_API_KEY?.trim()) return { configured: true, source: 'ANTHROPIC_API_KEY' };
    if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return { configured: true, source: 'CLAUDE_CODE_OAUTH_TOKEN' };

    const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(userHome, '.claude');
    const settingsPath = join(configDir, 'settings.json');
    try {
        if (fileExists(settingsPath)) {
            const settings = JSON.parse(readText(settingsPath)) as { apiKeyHelper?: unknown };
            if (typeof settings.apiKeyHelper === 'string' && settings.apiKeyHelper.trim()) {
                return { configured: true, source: 'Claude apiKeyHelper' };
            }
        }
    } catch {
        // Claude itself owns this file. A malformed or temporarily unreadable
        // file is reported as undetected instead of exposing its contents.
    }

    if (fileExists(join(configDir, '.credentials.json'))) {
        return { configured: true, source: 'Claude local credentials' };
    }
    return { configured: false };
}

export function toolProbeLabel(tool: ToolProbe): string {
    return tool.version ? `${tool.command} (${tool.version})` : tool.command;
}

export type DaemonReadiness = {
    level: 'ready' | 'next' | 'warning';
    message: string;
};

export type ShareableSettingsSummary = {
    schemaVersion?: number;
    onboardingCompleted?: boolean;
    machineIdConfigured: boolean;
    serverUrlConfigured: boolean;
    webappUrlConfigured: boolean;
    sandboxEnabled: boolean;
    chromeMode: boolean;
    boardLlm: boolean;
    todoProviderConfigured: boolean;
    terminalAutoRestore: boolean | 'default';
};

/** Fixed allowlist for `doctor`; unknown settings and command arguments stay private. */
export function shareableSettingsSummary(value: unknown): ShareableSettingsSummary {
    const settings = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const sandbox = settings.sandboxConfig && typeof settings.sandboxConfig === 'object'
        ? settings.sandboxConfig as Record<string, unknown>
        : {};
    return {
        ...(typeof settings.schemaVersion === 'number' ? { schemaVersion: settings.schemaVersion } : {}),
        ...(typeof settings.onboardingCompleted === 'boolean'
            ? { onboardingCompleted: settings.onboardingCompleted }
            : {}),
        machineIdConfigured: typeof settings.machineId === 'string' && settings.machineId.length > 0,
        serverUrlConfigured: typeof settings.serverUrl === 'string' && settings.serverUrl.length > 0,
        webappUrlConfigured: typeof settings.webappUrl === 'string' && settings.webappUrl.length > 0,
        sandboxEnabled: sandbox.enabled === true,
        chromeMode: settings.chromeMode === true,
        boardLlm: settings.boardLlm === true,
        todoProviderConfigured: Boolean(settings.todoProvider),
        terminalAutoRestore: typeof settings.terminalAutoRestore === 'boolean'
            ? settings.terminalAutoRestore
            : 'default',
    };
}

type SpawnProbe = (
    command: string,
    args: string[],
    options: { encoding: 'utf8'; timeout: number; windowsHide: true },
) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr' | 'error'>;

function firstUsefulLine(output: unknown): string | undefined {
    if (typeof output !== 'string') return undefined;
    const line = output.split(/\r?\n/).map(value => value.trim()).find(Boolean);
    if (!line) return undefined;
    return Array.from(line).slice(0, 160).join('');
}

export function nodeMajor(version: string): number | undefined {
    const match = /^v?(\d+)/.exec(version.trim());
    return match ? Number(match[1]) : undefined;
}

export function nodeSupported(version: string): boolean {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
    if (!match) return false;
    const [major, minor, patch] = match.slice(1).map(Number);
    if (major === 20) return minor >= 19;
    if (major === 22) return minor >= 13;
    return major >= 24;
}

function normalizedEndpoint(value: string): string {
    try {
        const parsed = new URL(value);
        return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    } catch {
        return value.replace(/\/+$/, '');
    }
}

export function daemonEndpointsMatch(
    stateServerUrl: string | undefined,
    stateWebappUrl: string | undefined,
    configuredServerUrl: string,
    configuredWebappUrl: string,
): boolean {
    return Boolean(
        stateServerUrl
        && stateWebappUrl
        && normalizedEndpoint(stateServerUrl) === normalizedEndpoint(configuredServerUrl)
        && normalizedEndpoint(stateWebappUrl) === normalizedEndpoint(configuredWebappUrl),
    );
}

export function tmuxSupportsSessionEnv(version: string | undefined): boolean {
    if (!version) return false;
    if (/master/i.test(version)) return true;
    const match = /(\d+)\.(\d+)/.exec(version);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major > MIN_TMUX_ENV_MAJOR
        || (major === MIN_TMUX_ENV_MAJOR && minor >= MIN_TMUX_ENV_MINOR);
}

function probe(command: ToolProbe['command'], run: SpawnProbe): ToolProbe {
    try {
        const result = run(command, command === 'tmux' ? ['-V'] : ['--version'], {
            encoding: 'utf8',
            timeout: 2_000,
            windowsHide: true,
        });
        const version = firstUsefulLine(result.stdout) ?? firstUsefulLine(result.stderr);
        return {
            command,
            available: !result.error && result.status === 0,
            ...(version ? { version } : {}),
        };
    } catch {
        return { command, available: false };
    }
}

export function daemonReadiness(
    authenticated: boolean,
    running: boolean,
    hasState: boolean,
): DaemonReadiness {
    if (running && hasState) {
        return { level: 'ready', message: '✓ Daemon is running' };
    }
    if (hasState) {
        return { level: 'warning', message: '⚠️  Daemon state exists but process not running (stale)' };
    }
    if (!authenticated) {
        return {
            level: 'next',
            message: '○ Daemon not started yet — pair this machine, then run `very-happy daemon start`',
        };
    }
    return {
        level: 'warning',
        message: '⚠️  Daemon is not running — run `very-happy daemon start`',
    };
}

export function collectRuntimeReadiness(
    run: SpawnProbe = spawnSync,
    currentNodeVersion = process.version,
): RuntimeReadiness {
    const tmux = probe('tmux', run);
    return {
        node: {
            version: currentNodeVersion,
            supported: nodeSupported(currentNodeVersion),
        },
        tmux: {
            ...tmux,
            supportsSessionEnv: tmux.available && tmuxSupportsSessionEnv(tmux.version),
        },
        agents: (['claude', 'codex', 'gemini', 'opencode', 'openclaw'] as const)
            .map(command => probe(command, run)),
    };
}
