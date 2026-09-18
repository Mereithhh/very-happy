/**
 * `very-happy mcp` — standalone stdio MCP server for an agent very-happy did
 * not inject its own MCP server into.
 *
 * Why it exists: remote Claude SDK sessions get the `happy` MCP server injected
 * by the session process itself, but a plain `claude` running inside a web
 * terminal (tmux) — or a pi / codex agent that loads its own MCP config — only
 * sees the user's normal MCP registrations. Registering this once:
 *
 *   claude mcp add --scope user very-happy-clipboard -- very-happy mcp
 *   pi: very-happy install-pi-tools (then launch pi directly)
 *
 * gives that agent a `copy_to_clipboard` tool. The tool forwards the text to
 * the local very-happy daemon over its existing 127.0.0.1 control server
 * (`POST /clipboard`, port discovered from the daemon state file); the daemon
 * relays it over its authenticated machine socket — encrypted with the
 * per-machine key — and the server fans it out to every web client the user
 * has open.
 *
 * Inside a meta-agent session (HAPPY_SESSION_VARIANT=assistant, non-Claude
 * runner) the same server additionally exposes the assistant's six session
 * tools — see mcpToolSurface.ts for the exact rule and why Claude is excluded.
 *
 * IMPORTANT: this process must never write to stdout (it would corrupt the MCP
 * stdio framing). logger.debug is file-only; errors go to stderr.
 */

import { registerTeamsTools } from '@/teams/tools';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pushClipboardViaDaemon, pushFilePreviewViaDaemon, setTerminalTitleViaDaemon } from '@/daemon/controlClient';
import { CLIPBOARD_MAX_BYTES, CLIPBOARD_TOOL_DESCRIPTION, CLIPBOARD_TOOL_NAME, CLIPBOARD_TOOL_TITLE } from '@/clipboard/limits';
import { registerAssistantSessionTools, type AssistantToolRegistrar } from '@/assistant/assistantTools';
import { logger } from '@/ui/logger';
import { checkPreviewPath } from '@/claude/utils/previewPath';
import { PREVIEW_TOOL_DESCRIPTION, PREVIEW_TOOL_NAME, PREVIEW_TOOL_TITLE } from '@/claude/utils/agentGuidance';
import { resolveMcpTerminalId, resolveMcpToolSurface, TERMINAL_TITLE_TOOL_NAME, type McpToolSurface } from './mcpToolSurface';

/** Register every tool of `surface` (+ the terminal row when `terminalId` is set) on `server` (pure over the registrar, unit-tested). */
export function registerMcpTools(server: AssistantToolRegistrar, surface: McpToolSurface, terminalId: string | null = null): void {
    server.registerTool(CLIPBOARD_TOOL_NAME, {
        description: CLIPBOARD_TOOL_DESCRIPTION,
        title: CLIPBOARD_TOOL_TITLE,
        inputSchema: {
            text: z.string().describe("The text to copy to the user's clipboard"),
        },
    }, async (args) => {
        logger.debug(`[MCP] copy_to_clipboard called (${args.text.length} chars)`);
        const result = await pushClipboardViaDaemon(args.text, terminalId ?? undefined);

        if (result.delivered) {
            const note = result.truncated
                ? ` (truncated to ${CLIPBOARD_MAX_BYTES / 1024}KB — original was ${result.totalBytes} bytes)`
                : '';
            return {
                content: [{
                    type: 'text' as const,
                    text: `Queued a clipboard request for the user's open Very Happy device(s)${note}. This does not confirm that a browser wrote the clipboard; the user may need to tap a confirmation button.`,
                }],
                isError: false,
            };
        }

        return {
            content: [{
                type: 'text' as const,
                text: `Failed to push to clipboard: ${result.error || 'unknown error'}. `
                    + 'The very-happy daemon must be running on this machine (start it with `very-happy daemon start`).',
            }],
            isError: true,
        };
    });

    if (terminalId) {
        server.registerTool(PREVIEW_TOOL_NAME, {
            description: PREVIEW_TOOL_DESCRIPTION,
            title: PREVIEW_TOOL_TITLE,
            inputSchema: {
                path: z.string().min(1).describe('Absolute path or path relative to the current working directory'),
                mode: z.enum(['file', 'diff']).optional().describe("'file' (default) previews the file; 'diff' is reserved and currently falls back to 'file'"),
            },
        }, async (args) => {
            const verdict = checkPreviewPath(args.path);
            if (verdict.deniedReason) return { content: [{ type: 'text' as const, text: verdict.deniedReason }], isError: true };
            const result = await pushFilePreviewViaDaemon(terminalId, verdict.resolved, args.mode ?? 'file');
            return {
                content: [{ type: 'text' as const, text: result.delivered
                    ? `Queued a preview request for ${verdict.resolved}. This does not confirm that a browser opened it.`
                    : `Failed to request preview: ${result.error || 'unknown error'}` }],
                isError: !result.delivered,
            };
        });
        server.registerTool(TERMINAL_TITLE_TOOL_NAME, {
            description: 'Change the title of the very-happy web terminal this agent is running in',
            title: 'Change Terminal Title',
            inputSchema: {
                title: z.string().min(1).max(200).describe('The new title for this terminal'),
            },
        }, async (args) => {
            logger.debug(`[MCP] change_title called for terminal ${terminalId}`);
            const result = await setTerminalTitleViaDaemon(terminalId, args.title);
            if (result.ok) {
                return {
                    content: [{ type: 'text' as const, text: `Successfully changed terminal title to: "${args.title}"` }],
                    isError: false,
                };
            }
            return {
                content: [{
                    type: 'text' as const,
                    text: `Failed to change terminal title: ${result.error || 'unknown error'}. `
                        + 'The very-happy daemon must be running on this machine (start it with `very-happy daemon start`).',
                }],
                isError: true,
            };
        });
    }

    if (surface === 'assistant' && !process.env.VH_TEAM_SCOPE_FILE) {
        registerAssistantSessionTools(server);
    }
}

export async function handleMcpCommand(terminalToolsOnly = false): Promise<void> {
    const server = new McpServer({
        name: 'very-happy',
        version: '1.0.0',
    });

    const surface = terminalToolsOnly ? 'clipboard' : resolveMcpToolSurface(process.env);
    const terminalId = resolveMcpTerminalId(process.env);
    if (terminalToolsOnly && !terminalId) throw new Error('Very Happy terminal context is required');
    registerMcpTools(server, surface, terminalId);
    if (!terminalToolsOnly && process.env.HAPPY_MANAGED !== '1' && !process.env.HAPPY_MCP_URL) registerTeamsTools(server, process.env.HAPPY_SESSION_ID);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.debug(`[MCP] very-happy stdio MCP server started (surface=${surface}, terminal=${terminalId ?? 'none'})`);

    // Keep the process alive until stdin closes (client disconnected).
    await new Promise<void>((resolve) => {
        process.stdin.on('close', resolve);
        process.stdin.on('end', resolve);
    });
}
