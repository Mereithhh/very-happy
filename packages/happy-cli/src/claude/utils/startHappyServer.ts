/**
 * Happy MCP server
 * Provides Happy CLI specific tools including chat session title management
 *
 * Uses stateless StreamableHTTP: each request gets a fresh McpServer + transport.
 * This is required by MCP SDK >=1.27 which rejects reuse of an already-connected transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";
import { CLIPBOARD_MAX_BYTES, CLIPBOARD_TOOL_DESCRIPTION, CLIPBOARD_TOOL_NAME, CLIPBOARD_TOOL_TITLE } from "@/clipboard/limits";

interface HappyMcpHandlers {
    changeTitle: (title: string) => Promise<{ success: boolean; error?: string }>;
    copyToClipboard: (text: string) => Promise<{ delivered: boolean; truncated: boolean; totalBytes: number; error?: string }>;
}

function createMcpServer(handlers: HappyMcpHandlers): McpServer {
    const mcp = new McpServer({
        name: "Happy MCP",
        version: "1.0.0",
    });

    mcp.registerTool('change_title', {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: {
            title: z.string().describe('The new title for the chat session'),
        },
    }, async (args) => {
        const response = await handlers.changeTitle(args.title);
        logger.debug('[happyMCP] Response:', response);

        if (response.success) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Successfully changed chat title to: "${args.title}"`,
                    },
                ],
                isError: false,
            };
        } else {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        }
    });

    mcp.registerTool(CLIPBOARD_TOOL_NAME, {
        description: CLIPBOARD_TOOL_DESCRIPTION,
        title: CLIPBOARD_TOOL_TITLE,
        inputSchema: {
            text: z.string().describe('The text to copy to the user\'s clipboard'),
        },
    }, async (args) => {
        const response = await handlers.copyToClipboard(args.text);
        logger.debug('[happyMCP] copy_to_clipboard response:', response);

        if (response.delivered) {
            const note = response.truncated
                ? ` (truncated to ${CLIPBOARD_MAX_BYTES / 1024}KB — original was ${response.totalBytes} bytes)`
                : '';
            return {
                content: [{
                    type: 'text',
                    text: `Sent to the user's clipboard on their currently open device(s)${note}. If the page was not focused, they may need to tap a confirmation button.`,
                }],
                isError: false,
            };
        }
        return {
            content: [{
                type: 'text',
                text: `Failed to push to clipboard: ${response.error || 'not connected to the server'}`,
            }],
            isError: true,
        };
    });

    return mcp;
}

export async function startHappyServer(client: ApiSessionClient) {
    logger.debug(`[happyMCP] server:start sessionId=${client.sessionId}`);

    const handlers: HappyMcpHandlers = {
        changeTitle: async (title: string) => {
            logger.debug('[happyMCP] Changing title to:', title);
            try {
                client.sendClaudeSessionMessage({
                    type: 'summary',
                    summary: title,
                    leafUuid: randomUUID()
                });
                return { success: true };
            } catch (error) {
                return { success: false, error: String(error) };
            }
        },
        copyToClipboard: async (text: string) => {
            logger.debug(`[happyMCP] Pushing ${text.length} chars to clipboard`);
            try {
                return client.pushClipboard(text);
            } catch (error) {
                return { delivered: false, truncated: false, totalBytes: 0, error: String(error) };
            }
        },
    };

    const server = createServer(async (req, res) => {
        const mcp = createMcpServer(handlers);
        try {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined
            });
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
            res.on('close', () => {
                transport.close();
                mcp.close();
            });
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            mcp.close();
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    logger.debug(`[happyMCP] server:ready sessionId=${client.sessionId} url=${baseUrl.toString()}`);

    return {
        url: baseUrl.toString(),
        toolNames: ['change_title', CLIPBOARD_TOOL_NAME],
        stop: () => {
            logger.debug(`[happyMCP] server:stop sessionId=${client.sessionId}`);
            server.close();
        }
    }
}
