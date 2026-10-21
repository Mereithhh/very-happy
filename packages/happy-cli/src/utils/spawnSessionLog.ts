export type SpawnSessionLogSummary = {
  agent?: string;
  variant?: string;
  sessionId?: string;
  hasDirectory: boolean;
  hasToken: boolean;
  environmentVariableNames: string[];
  resumesClaude: boolean;
  resumesCodex: boolean;
  importsClaude: boolean;
  forceNew: boolean;
  permissionMode?: string;
  /** B-723: the Web entry point that asked (source / route shape / tab visible / user gesture). */
  origin?: { source: string; route: string; visible: boolean | null; gesture: boolean | null };
};

/** B-723: diagnostic `origin` from the Web — allowlisted shapes only, never free text. */
function spawnOriginForLog(value: unknown): SpawnSessionLogSummary['origin'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const source = typeof input.source === 'string' && /^[a-z][a-z-]{0,23}$/.test(input.source) ? input.source : 'invalid';
  const route = typeof input.route === 'string' && /^[A-Za-z0-9/:._-]{1,64}$/.test(input.route) ? input.route : 'invalid';
  const flag = (v: unknown) => (typeof v === 'boolean' ? v : null);
  return { source, route, visible: flag(input.visible), gesture: flag(input.gesture) };
}

/** Allowlisted diagnostics for remote spawn requests; never include secret values. */
export function summarizeSpawnSessionForLog(value: unknown): SpawnSessionLogSummary {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const environmentVariables = input.environmentVariables && typeof input.environmentVariables === 'object'
    ? input.environmentVariables as Record<string, unknown>
    : {};
  return {
    ...(typeof input.agent === 'string' ? { agent: input.agent } : {}),
    ...(typeof input.variant === 'string' ? { variant: input.variant } : {}),
    ...(typeof input.sessionId === 'string' ? { sessionId: input.sessionId } : {}),
    hasDirectory: typeof input.directory === 'string' && input.directory.length > 0,
    hasToken: typeof input.token === 'string' && input.token.length > 0,
    environmentVariableNames: Object.keys(environmentVariables).sort(),
    resumesClaude: typeof input.resumeClaudeSessionId === 'string' && input.resumeClaudeSessionId.length > 0,
    resumesCodex: typeof input.resumeCodexThreadId === 'string' && input.resumeCodexThreadId.length > 0,
    importsClaude: typeof input.importedFromClaudeSessionId === 'string' && input.importedFromClaudeSessionId.length > 0,
    forceNew: input.forceNew === true,
    ...(typeof input.permissionMode === 'string' ? { permissionMode: input.permissionMode } : {}),
    ...(input.origin !== undefined ? { origin: spawnOriginForLog(input.origin) } : {}),
  };
}
