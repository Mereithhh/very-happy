/**
 * Which tools the standalone `very-happy mcp` stdio server exposes.
 *
 * Two surfaces, decided purely from the environment the MCP process inherits:
 *
 *  - `clipboard` (default): `copy_to_clipboard` only — exactly what the command
 *    has always offered a plain `claude`.
 *  - `assistant`: clipboard + the six session tools of the meta-agent
 *    (`ASSISTANT_SESSION_TOOL_NAMES`). Chosen when the process runs inside a
 *    session the daemon spawned with `variant: 'assistant'`: the daemon injects
 *    HAPPY_SESSION_VARIANT=assistant into the wrapper, the ACP / codex runners
 *    hand `process.env` to their agent child, and agents hand it to the MCP
 *    servers they start — so a pi (or any non-Claude) meta-agent reaches the
 *    same tool set through the user's ordinary MCP registration, without a
 *    runner-specific injection path.
 *
 * Orthogonal to the surface, a *terminal context* (VH_TERMINAL_ID set: the
 * agent runs inside a vh web terminal, see webTerminal.ts) adds `change_title`,
 * which titles that terminal through the daemon's /terminal-title endpoint —
 * pi has no hooks and no mirror session, so this is the only way a hand-run pi
 * can name its tab. Managed ACP sessions use the in-process happy server
 * (HAPPY_MCP_URL) instead, whose `change_title` names the *session*. The two
 * DO overlap when `very-happy pi` is typed inside a web terminal (runAcp runs
 * in that shell, AcpBackend spreads process.env, so the child sees both
 * variables): HAPPY_MCP_URL wins there and the terminal row is dropped, or a
 * bridge extension proxying the happy server would register a second
 * `change_title` next to this one.
 *
 * Claude is the deliberate exception: runClaude injects the assistant tools
 * in-process (startHappyServer) AND stamps HAPPY_MANAGED=1 on the claude child
 * (B-105). A user who also registered `very-happy mcp` user-wide would otherwise
 * see every session tool twice, so HAPPY_MANAGED=1 keeps this server on the
 * clipboard surface there. No new plumbing: both variables already exist.
 */

import { CLIPBOARD_TOOL_NAME } from '@/clipboard/limits'
import { ASSISTANT_SESSION_TOOL_NAMES } from '@/assistant/assistantTools'

export type McpToolSurface = 'clipboard' | 'assistant'

export type McpSurfaceEnv = { HAPPY_SESSION_VARIANT?: string; HAPPY_MANAGED?: string; VH_TERMINAL_ID?: string; HAPPY_MCP_URL?: string }

export const TERMINAL_TITLE_TOOL_NAME = 'change_title'

/**
 * The web terminal id this MCP process runs inside, or null when not in a
 * terminal — or when a managed ACP session (HAPPY_MCP_URL) owns `change_title`.
 */
export function resolveMcpTerminalId(env: McpSurfaceEnv): string | null {
    if (env.HAPPY_MCP_URL) return null
    const id = env.VH_TERMINAL_ID
    return id && /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : null
}

export function resolveMcpToolSurface(env: McpSurfaceEnv): McpToolSurface {
    if (env.HAPPY_SESSION_VARIANT !== 'assistant') return 'clipboard'
    if (env.HAPPY_MANAGED === '1') return 'clipboard'
    return 'assistant'
}

export function mcpToolNamesForSurface(surface: McpToolSurface, terminalId: string | null = null): readonly string[] {
    return [
        CLIPBOARD_TOOL_NAME,
        ...(terminalId ? [TERMINAL_TITLE_TOOL_NAME] : []),
        ...(surface === 'assistant' ? ASSISTANT_SESSION_TOOL_NAMES : []),
    ]
}
