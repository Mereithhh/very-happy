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
 *   (pi: an entry in ~/.pi/agent/mcp.json, see docs/channels.md)
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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pushClipboardViaDaemon } from '@/daemon/controlClient';
import { CLIPBOARD_MAX_BYTES, CLIPBOARD_TOOL_DESCRIPTION, CLIPBOARD_TOOL_NAME, CLIPBOARD_TOOL_TITLE } from '@/clipboard/limits';
import { registerAssistantSessionTools, type AssistantToolRegistrar } from '@/assistant/assistantTools';
import { logger } from '@/ui/logger';
import { resolveMcpToolSurface, type McpToolSurface } from './mcpToolSurface';

/** Register every tool of `surface` on `server` (pure over the registrar, unit-tested). */
export function registerMcpTools(server: AssistantToolRegistrar, surface: McpToolSurface): void {
    server.registerTool(CLIPBOARD_TOOL_NAME, {
        description: CLIPBOARD_TOOL_DESCRIPTION,
        title: CLIPBOARD_TOOL_TITLE,
        inputSchema: {
            text: z.string().describe("The text to copy to the user's clipboard"),
        },
    }, async (args) => {
        logger.debug(`[MCP] copy_to_clipboard called (${args.text.length} chars)`);
        const result = await pushClipboardViaDaemon(args.text);

        if (result.delivered) {
            const note = result.truncated
                ? ` (truncated to ${CLIPBOARD_MAX_BYTES / 1024}KB — original was ${result.totalBytes} bytes)`
                : '';
            return {
                content: [{
                    type: 'text' as const,
                    text: `Sent to the user's clipboard on their currently open device(s)${note}. If the page was not focused, they may need to tap a confirmation button.`,
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

    if (surface === 'assistant') {
        registerAssistantSessionTools(server);
    }
}

export async function handleMcpCommand(): Promise<void> {
    const server = new McpServer({
        name: 'very-happy',
        version: '1.0.0',
    });

    const surface = resolveMcpToolSurface(process.env);
    registerMcpTools(server, surface);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.debug(`[MCP] very-happy stdio MCP server started (surface=${surface})`);

    // Keep the process alive until stdin closes (client disconnected).
    await new Promise<void>((resolve) => {
        process.stdin.on('close', resolve);
        process.stdin.on('end', resolve);
    });
}
