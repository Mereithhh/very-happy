export type SchedulerEnvironmentId = 'computer' | 'server' | 'runtime';
export type SchedulerAgentId = 'claude' | 'codex' | 'opencode' | 'terminal';
export type SchedulerLaneId = 'cli' | 'api' | 'mcp' | 'meta';

export type SchedulerTopologyState = {
  environment: SchedulerEnvironmentId;
  agent: SchedulerAgentId;
  inspectedLane: SchedulerLaneId;
};

export type SchedulerTopologyAction =
  | { type: 'select-environment'; id: SchedulerEnvironmentId }
  | { type: 'select-agent'; id: SchedulerAgentId }
  | { type: 'inspect-lane'; id: SchedulerLaneId };

export const INITIAL_SCHEDULER_TOPOLOGY_STATE: SchedulerTopologyState = {
  environment: 'computer',
  agent: 'claude',
  inspectedLane: 'cli',
};

export const SCHEDULER_ENVIRONMENT_LABELS: Record<SchedulerEnvironmentId, string> = {
  computer: 'Your computer',
  server: 'Remote server',
  runtime: 'Any runtime',
};

export const SCHEDULER_AGENT_LABELS: Record<SchedulerAgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  terminal: 'Any text TUI',
};

export const SCHEDULER_LANE_DESCRIPTIONS: Record<SchedulerLaneId, string> = {
  cli: 'CLI + daemon · required machine bridge',
  api: 'API + webhooks · trusted server edge',
  mcp: 'MCP tools · runner-specific surface',
  meta: 'Meta Agent · optional Claude-only coordinator',
};

export function schedulerTopologyReducer(
  state: SchedulerTopologyState,
  action: SchedulerTopologyAction,
): SchedulerTopologyState {
  switch (action.type) {
    case 'select-environment':
      return { ...state, environment: action.id };
    case 'select-agent':
      return { ...state, agent: action.id };
    case 'inspect-lane':
      return { ...state, inspectedLane: action.id };
  }
}

export function getSchedulerRouteLabel(state: SchedulerTopologyState): string {
  return `${SCHEDULER_ENVIRONMENT_LABELS[state.environment]} → ${SCHEDULER_AGENT_LABELS[state.agent]}`;
}

export function getSchedulerActiveWireIds(state: SchedulerTopologyState): string[] {
  return [`environment:${state.environment}`, `agent:${state.agent}`];
}
