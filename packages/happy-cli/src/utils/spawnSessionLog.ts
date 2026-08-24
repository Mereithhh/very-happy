export type SpawnSessionLogSummary = {
  agent?: string;
  variant?: string;
  sessionId?: string;
  hasDirectory: boolean;
  hasToken: boolean;
  environmentVariableNames: string[];
  resumesClaude: boolean;
  resumesCodex: boolean;
  forceNew: boolean;
  permissionMode?: string;
};

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
    forceNew: input.forceNew === true,
    ...(typeof input.permissionMode === 'string' ? { permissionMode: input.permissionMode } : {}),
  };
}
