/** Managed sessions own their title; terminal tools target only a valid terminal id. */
export function resolveMcpTerminalId(env: { HAPPY_MCP_URL?: string; VH_TERMINAL_ID?: string }): string | null {
    if (env.HAPPY_MCP_URL) return null;
    const id = env.VH_TERMINAL_ID;
    return id && /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : null;
}
