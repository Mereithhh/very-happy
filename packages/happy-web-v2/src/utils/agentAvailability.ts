import type { MachineMetadata } from '@/sync/storageTypes';

export const SESSION_AGENTS = ['claude', 'codex', 'gemini', 'openclaw', 'pi'] as const;
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
    if (agent === 'pi') {
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
    if (agent !== 'pi') return true;
    return metadata?.cliAvailability?.pi !== undefined;
}

export type AgentSetupInstruction =
    | { kind: 'command'; command: string }
    | { kind: 'gateway' };

export function agentSetupInstruction(agent: Exclude<SessionAgent, 'claude'>): AgentSetupInstruction {
    switch (agent) {
        case 'codex': return { kind: 'command', command: 'npm install -g @openai/codex' };
        case 'gemini': return { kind: 'command', command: 'npm install -g @google/gemini-cli' };
        case 'openclaw': return { kind: 'gateway' };
        // pi itself plus the ACP adapter very-happy drives it through.
        case 'pi': return { kind: 'command', command: 'npm install -g @earendil-works/pi-coding-agent pi-acp@0.0.33' };
    }
}
