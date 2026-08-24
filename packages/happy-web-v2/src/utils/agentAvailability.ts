import type { MachineMetadata } from '@/sync/storageTypes';

export const SESSION_AGENTS = ['claude', 'codex', 'gemini', 'openclaw'] as const;
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
 */
export function resolveAgentAvailability(
    metadata: MachineMetadata | null | undefined,
    agent: SessionAgent,
): AgentAvailability {
    const externallyDetected = metadata?.cliAvailability?.[agent];
    if (agent === 'claude') {
        return { available: true, bundled: true, externallyDetected };
    }
    return {
        available: externallyDetected !== false,
        bundled: false,
        externallyDetected,
    };
}

export type AgentSetupInstruction =
    | { kind: 'command'; command: string }
    | { kind: 'gateway' };

export function agentSetupInstruction(agent: Exclude<SessionAgent, 'claude'>): AgentSetupInstruction {
    switch (agent) {
        case 'codex': return { kind: 'command', command: 'npm install -g @openai/codex' };
        case 'gemini': return { kind: 'command', command: 'npm install -g @google/gemini-cli' };
        case 'openclaw': return { kind: 'gateway' };
    }
}
