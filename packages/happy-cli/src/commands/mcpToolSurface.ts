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
 * Claude is the deliberate exception: runClaude injects the assistant tools
 * in-process (startHappyServer) AND stamps HAPPY_MANAGED=1 on the claude child
 * (B-105). A user who also registered `very-happy mcp` user-wide would otherwise
 * see every session tool twice, so HAPPY_MANAGED=1 keeps this server on the
 * clipboard surface there. No new plumbing: both variables already exist.
 */

import { CLIPBOARD_TOOL_NAME } from '@/clipboard/limits'
import { ASSISTANT_SESSION_TOOL_NAMES } from '@/assistant/assistantTools'

export type McpToolSurface = 'clipboard' | 'assistant'

export type McpSurfaceEnv = { HAPPY_SESSION_VARIANT?: string; HAPPY_MANAGED?: string }

export function resolveMcpToolSurface(env: McpSurfaceEnv): McpToolSurface {
    if (env.HAPPY_SESSION_VARIANT !== 'assistant') return 'clipboard'
    if (env.HAPPY_MANAGED === '1') return 'clipboard'
    return 'assistant'
}

export function mcpToolNamesForSurface(surface: McpToolSurface): readonly string[] {
    return surface === 'assistant'
        ? [CLIPBOARD_TOOL_NAME, ...ASSISTANT_SESSION_TOOL_NAMES]
        : [CLIPBOARD_TOOL_NAME]
}
