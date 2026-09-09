import { getAgentDefaultOverride, type AgentDefaultOverrides } from './agentDefaults';

export function resolveSpawnModel(options: {
    agent?: string;
    model?: string;
    resumeClaudeSessionId?: string;
    resumeCodexThreadId?: string;
    parentSessionId?: string;
    variant?: string;
}, overrides: AgentDefaultOverrides | undefined): string | undefined {
    if (options.model !== undefined) return options.model === 'default' ? undefined : options.model;
    // A fork or assistant retains its own model intent. Only fresh pi sessions
    // adopt the account preference; old daemons safely ignore this new field.
    if (options.agent !== 'pi' || options.resumeClaudeSessionId || options.resumeCodexThreadId || options.parentSessionId || options.variant) return undefined;
    const selected = getAgentDefaultOverride(overrides, 'pi').modelMode;
    return selected && selected !== 'default' ? selected : undefined;
}
