/**
 * B-657: env a Very Happy managed session hands to its agent (and therefore to
 * any shell that agent runs, including `pnpm test`). Unit tests describe the
 * CLI as a plain process; inheriting these flips real branches — a team scope
 * hides the assistant MCP tools, a team operation id makes a session
 * ineligible for prewarm — so the same suite passed in CI and failed when an
 * agent ran it. The unit project's setup file strips them before every file.
 *
 * Machine configuration (HAPPY_HOME_DIR, HAPPY_SERVER_URL, HAPPY_WEBAPP_URL,
 * HAPPY_CLAUDE_PATH, timeouts) is deliberately kept: a developer's isolated
 * home must not silently fall back to the real ~/.happy.
 */
const HOST_SESSION_KEYS: readonly string[] = [
    'HAPPY_MANAGED',
    'HAPPY_SPAWNED_BY',
    'HAPPY_DAEMON_SUPERVISOR',
    'HAPPY_SESSION_ID',
    'HAPPY_SESSION_VARIANT',
    'HAPPY_PERMISSION_MODE',
    'HAPPY_MCP_URL',
    'HAPPY_HTTP_MCP_URL',
    'HAPPY_TERMINAL_MCP_URL',
    'HAPPY_CONTEXT_USAGE_URL',
    'HAPPY_CLAUDE_PREWARM',
    'HAPPY_CLAUDE_AUTH_STATUS',
    'HAPPY_FIRST_MESSAGE_FROM_CLI',
    'HAPPY_IMPORT_TITLE',
    'HAPPY_IMPORTED_FROM_CLAUDE_SESSION_ID',
];
/** Every VH_* (team scope/operation, peer session, terminal id, …) and the per-spawn reconnect/fork hand-off. */
const HOST_SESSION_PREFIXES: readonly string[] = ['VH_', 'HAPPY_RECONNECT_', 'HAPPY_FORK'];

export function isHostSessionEnvKey(key: string): boolean {
    return HOST_SESSION_KEYS.includes(key) || HOST_SESSION_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Deletes the host-session keys from `env` in place; returns the names removed. */
export function stripHostSessionEnv(env: NodeJS.ProcessEnv = process.env): string[] {
    const removed = Object.keys(env).filter(isHostSessionEnvKey);
    for (const key of removed) delete env[key];
    return removed;
}
