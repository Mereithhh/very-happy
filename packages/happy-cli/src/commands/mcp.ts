/**
 * `very-happy mcp` — standalone stdio MCP server for the REAL claude CLI.
 *
 * Why it exists: remote SDK sessions get the `happy` MCP server injected by the
 * session process itself, but a plain `claude` running inside a web terminal
 * (tmux) only loads the user's normal MCP config. Registering this once:
 *
 *   claude mcp add --scope user very-happy-clipboard -- very-happy mcp
 *
 * gives that claude a `copy_to_clipboard` tool. The tool forwards the text to
 * the local very-happy daemon over its existing 127.0.0.1 control server
 * (`POST /clipboard`, port discovered from the daemon state file); the daemon
 * relays it over its authenticated machine socket — encrypted with the
 * per-machine key — and the server fans it out to every web client the user
 * has open.
 *
 * IMPORTANT: this process must never write to stdout (it would corrupt the MCP
 * stdio framing). logger.debug is file-only; errors go to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pushClipboardViaDaemon } from '@/daemon/controlClient';
import { CLIPBOARD_MAX_BYTES, CLIPBOARD_TOOL_DESCRIPTION, CLIPBOARD_TOOL_NAME, CLIPBOARD_TOOL_TITLE } from '@/clipboard/limits';
import { logger } from '@/ui/logger';

export async function handleMcpCommand(): Promise<void> {
    const server = new McpServer({
        name: 'very-happy',
        version: '1.0.0',
    });

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

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.debug('[MCP] very-happy stdio MCP server started');

    // Keep the process alive until stdin closes (client disconnected).
    await new Promise<void>((resolve) => {
        process.stdin.on('close', resolve);
        process.stdin.on('end', resolve);
    });
}
