import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { SandboxConfig } from '@/persistence';

function expandPath(pathValue: string, sessionPath: string): string {
    const expandedHome = pathValue.replace(/^~(?=\/|$)/, homedir());
    if (isAbsolute(expandedHome)) {
        return expandedHome;
    }

    return resolve(sessionPath, expandedHome);
}

function resolvePaths(paths: string[], sessionPath: string): string[] {
    return paths.map((pathValue) => expandPath(pathValue, sessionPath));
}

function getSharedAgentStatePaths(sessionPath: string): string[] {
    const codexHome = process.env.CODEX_HOME || '~/.codex';
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || '~/.claude';

    return [
        expandPath(codexHome, sessionPath),
        expandPath(claudeConfigDir, sessionPath),
    ];
}

/** Same rule as `configuration.happyHomeDir` (not imported: that module has side effects). */
export function defaultHappyHomeDir(env: NodeJS.ProcessEnv = process.env): string {
    return env.HAPPY_HOME_DIR ? env.HAPPY_HOME_DIR.replace(/^~/, homedir()) : join(homedir(), '.happy');
}

/**
 * B-585: paths a sandboxed agent must never write, whatever allowWrite says
 * (a workspaceRoot of `~` would otherwise cover HAPPY_HOME). The setup-script
 * approvals and approved run snapshots live here; writing them = self-approving
 * code that later runs unsandboxed.
 */
export function protectedWritePaths(happyHomeDir: string): string[] {
    return [join(resolve(happyHomeDir), 'worktree-setup')];
}

function uniquePaths(paths: string[]): string[] {
    return [...new Set(paths)];
}

export function buildSandboxRuntimeConfig(
    sandboxConfig: SandboxConfig,
    sessionPath: string,
    happyHomeDir: string = defaultHappyHomeDir(),
): SandboxRuntimeConfig {
    const extraWritePaths = resolvePaths(sandboxConfig.extraWritePaths, sessionPath);
    const sharedAgentStatePaths = getSharedAgentStatePaths(sessionPath);

    const allowWrite = (() => {
        switch (sandboxConfig.sessionIsolation) {
            case 'strict':
                return uniquePaths([resolve(sessionPath), ...extraWritePaths, ...sharedAgentStatePaths]);
            case 'workspace': {
                const workspaceRoot = sandboxConfig.workspaceRoot
                    ? expandPath(sandboxConfig.workspaceRoot, sessionPath)
                    : resolve(sessionPath);
                return uniquePaths([workspaceRoot, resolve(sessionPath), ...extraWritePaths, ...sharedAgentStatePaths]);
            }
            case 'custom':
                return uniquePaths([
                    ...resolvePaths(sandboxConfig.customWritePaths, sessionPath),
                    ...extraWritePaths,
                    ...sharedAgentStatePaths,
                ]);
        }
    })();

    const network = (() => {
        switch (sandboxConfig.networkMode) {
            case 'blocked':
                return {
                    allowedDomains: [] as string[],
                    deniedDomains: [] as string[],
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
            case 'allowed':
                return {
                    allowedDomains: undefined as unknown as string[],
                    deniedDomains: [] as string[],
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
            case 'custom':
                return {
                    allowedDomains: sandboxConfig.allowedDomains,
                    deniedDomains: sandboxConfig.deniedDomains,
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
        }
    })();

    const enableWeakerNetworkIsolation = sandboxConfig.networkMode === 'allowed'
        ? true
        : undefined;

    return {
        allowPty: true,
        enableWeakerNetworkIsolation,
        network,
        filesystem: {
            denyRead: resolvePaths(sandboxConfig.denyReadPaths, sessionPath),
            allowWrite,
            denyWrite: uniquePaths([...resolvePaths(sandboxConfig.denyWritePaths, sessionPath), ...protectedWritePaths(happyHomeDir)]),
        },
    };
}
