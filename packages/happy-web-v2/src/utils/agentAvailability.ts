import type { MachineMetadata } from '@/sync/storageTypes';

export const SESSION_AGENTS = ['claude', 'codex', 'gemini', 'openclaw', 'pi', 'dsh'] as const;
export type SessionAgent = (typeof SESSION_AGENTS)[number];

export type AgentAvailability = {
    available: boolean;
    bundled: boolean;
    externallyDetected: boolean | undefined;
};

/**
 * Resolve what the new-session launcher can actually start on a machine.
 *
 * Claude's structured session path is bundled with Very Happy, so it remains
 * available even when the optional external `claude` binary is absent. The
 * other launchers are machine-local integrations and are disabled only when a
 * current daemon explicitly reports them missing. Older daemons did not send
 * `cliAvailability`, so an unknown value stays enabled for compatibility and
 * the daemon remains the final authority.
 *
 * pi is the exception: its runner shipped together with the `pi` availability
 * field, so a daemon that omits the field is one that cannot spawn pi at all
 * (it would answer "Unsupported agent type"). Absence therefore means
 * unavailable, and only an explicit `true` enables it.
 */
export function resolveAgentAvailability(
    metadata: MachineMetadata | null | undefined,
    agent: SessionAgent,
): AgentAvailability {
    const externallyDetected = metadata?.cliAvailability?.[agent];
    if (agent === 'claude') {
        return { available: true, bundled: true, externallyDetected };
    }
    // B-952: dsh shipped with its field too — absence means a daemon that cannot spawn it.
    if (agent === 'pi' || agent === 'dsh') {
        return { available: externallyDetected === true, bundled: false, externallyDetected };
    }
    return {
        available: externallyDetected !== false,
        bundled: false,
        externallyDetected,
    };
}

/**
 * Whether the launcher should list `agent` for this machine at all. Everything
 * is listed (enabled or greyed out) except pi on a daemon that never reported
 * the `pi` field: that daemon predates the runner, so neither "install pi-acp"
 * nor "not installed" would be true advice — the fix is a CLI upgrade.
 */
export function isAgentOffered(
    metadata: MachineMetadata | null | undefined,
    agent: SessionAgent,
): boolean {
    if (agent !== 'pi' && agent !== 'dsh') return true;
    return metadata?.cliAvailability?.[agent] !== undefined;
}

/**
 * B-596: the agents the launcher lists for this machine but cannot start —
 * each gets an install row (revealed by selecting its greyed button). Claude
 * is bundled and never appears.
 */
export function agentsNeedingSetup(
    metadata: MachineMetadata | null | undefined,
): Exclude<SessionAgent, 'claude'>[] {
    if (!metadata?.cliAvailability) return [];
    return SESSION_AGENTS
        .filter((candidate): candidate is Exclude<SessionAgent, 'claude'> => candidate !== 'claude')
        .filter((candidate) => isAgentOffered(metadata, candidate))
        .filter((candidate) => !resolveAgentAvailability(metadata, candidate).available);
}

export type AgentSetupInstruction =
    | { kind: 'command'; command: string }
    | { kind: 'gateway' }
    /** B-952: dsh is installed but the daemon's `node` is older than dsh needs. */
    | { kind: 'node-upgrade'; nodeVersion: string | null; minimum: string; path: string | null };

/** B-952: DeepSeek Harness's `engines.node` floor. */
export const DSH_MIN_NODE = '24.9.0';
export const DSH_INSTALL_COMMAND = 'npm install -g @deepseek-ai/dsh';

export function agentSetupInstruction(agent: Exclude<SessionAgent, 'claude'>, metadata?: MachineMetadata | null): AgentSetupInstruction {
    switch (agent) {
        // The daemon reports `dshNode` only when `dsh` is on its PATH.
        case 'dsh': {
            const node = metadata?.cliAvailability?.dshNode;
            return node === undefined
                ? { kind: 'command', command: DSH_INSTALL_COMMAND }
                : { kind: 'node-upgrade', nodeVersion: node, minimum: DSH_MIN_NODE, path: metadata?.cliAvailability?.dshPath ?? null };
        }
        case 'codex': return { kind: 'command', command: 'npm install -g @openai/codex' };
        case 'gemini': return { kind: 'command', command: 'npm install -g @google/gemini-cli' };
        case 'openclaw': return { kind: 'gateway' };
        // pi itself plus the ACP adapter very-happy drives it through.
        case 'pi': return { kind: 'command', command: 'npm install -g @earendil-works/pi-coding-agent pi-acp@0.0.33' };
    }
}

/**
 * B-956: the daemon also looks in the login shell's PATH and the nvm / fnm /
 * volta / mise / asdf Node dirs for these agents (CLI 0.2.221+, which says so
 * with `binSearch`), so the setup row can say where it looked.
 */
export function agentSearchedBeyondPath(
    agent: Exclude<SessionAgent, 'claude'>,
    metadata: MachineMetadata | null | undefined,
): boolean {
    return (agent === 'dsh' || agent === 'pi' || agent === 'gemini') && metadata?.cliAvailability?.binSearch === 1;
}

/**
 * B-954: why an unavailable agent cannot start, for its short chip — dsh on the
 * PATH with a too-old (or missing) `node` is not 「未安装」.
 */
export function agentUnavailableReason(
    agent: Exclude<SessionAgent, 'claude'>,
    metadata: MachineMetadata | null | undefined,
): 'not-installed' | 'node-too-old' {
    return agentSetupInstruction(agent, metadata).kind === 'node-upgrade' ? 'node-too-old' : 'not-installed';
}
