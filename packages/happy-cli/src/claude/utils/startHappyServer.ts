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
import { ASSISTANT_TOOL_NAMES, registerAssistantTools } from "@/assistant/assistantTools";
import {
    PREVIEW_TOOL_DESCRIPTION, PREVIEW_TOOL_NAME, PREVIEW_TOOL_TITLE,
    REPORT_PROGRESS_TOOL_DESCRIPTION, REPORT_PROGRESS_TOOL_NAME, REPORT_PROGRESS_TOOL_TITLE,
} from "./agentGuidance";
import {
    type BoardAttention, type SelfReportState,
    createSelfReportState, normalizeProgress, shouldAcceptSelfReport,
} from "./boardReport";
import { checkPreviewPath } from "./previewPath";

interface HappyMcpHandlers {
    changeTitle: (title: string) => Promise<{ success: boolean; error?: string }>;
    copyToClipboard: (text: string) => Promise<{ delivered: boolean; truncated: boolean; totalBytes: number; error?: string }>;
    /** B-131: ask the user's web clients to open a file preview. */
    openPreview: (path: string, mode: 'file' | 'diff') => Promise<{ delivered: boolean; resolved?: string; error?: string }>;
    /** B-132: claude self-reports progress onto the task board. */
    reportProgress: (progress: string, attention: BoardAttention) => Promise<{ accepted: boolean; error?: string }>;
}

export interface StartHappyServerOptions {
    /**
     * B-132: 自报水位，由调用方（runClaude）创建并同时交给 BoardAnalyzer——
     * 两者在同一个 session 进程里，所以是共享的内存对象，不需要落文件。
     * 不传则本 server 自己建一个（水位无人消费，只起节流作用）。
     */
    selfReportState?: SelfReportState;
    /**
     * B-051: assistant-variant sessions additionally get the machine
     * management tool surface (sessions_* / terminal_* / memory_update).
     * Normal sessions keep exactly the stock two tools.
     */
    assistant?: boolean;
}

function createMcpServer(handlers: HappyMcpHandlers, options?: StartHappyServerOptions): McpServer {
    const mcp = new McpServer({
        name: "Very Happy Tools",
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

    // B-131 open_preview —— 只推路径，web 端自己用既有 fs-read 拉内容。
    mcp.registerTool(PREVIEW_TOOL_NAME, {
        description: PREVIEW_TOOL_DESCRIPTION,
        title: PREVIEW_TOOL_TITLE,
        inputSchema: {
            path: z.string().describe('Absolute path (or ~/…) of the file to show the user'),
            mode: z.enum(['file', 'diff']).optional()
                .describe("'file' (default) renders the file; 'diff' is reserved and currently falls back to 'file'"),
        },
    }, async (args) => {
        const response = await handlers.openPreview(args.path, args.mode ?? 'file');
        logger.debug('[happyMCP] open_preview response:', response);
        if (response.delivered) {
            return {
                content: [{
                    type: 'text',
                    // 明说不保证用户看到了——否则 claude 会基于「已预览」做后续推断（spec 风险 8）
                    text: `Asked the user's open web client(s) to preview ${response.resolved ?? args.path}. `
                        + 'This does not confirm they looked at it.',
                }],
                isError: false,
            };
        }
        return {
            content: [{ type: 'text', text: `Could not open preview: ${response.error || 'unknown error'}` }],
            isError: true,
        };
    });

    // B-132 report_progress —— 写 session metadata 的 board 字段，复用既有 sessions push。
    mcp.registerTool(REPORT_PROGRESS_TOOL_NAME, {
        description: REPORT_PROGRESS_TOOL_DESCRIPTION,
        title: REPORT_PROGRESS_TOOL_TITLE,
        inputSchema: {
            progress: z.string().describe('One short line describing the current state of this task'),
            attention: z.enum(['none', 'review', 'blocked']).optional()
                .describe("'blocked' = cannot proceed without the user; 'review' = wants their eyes; 'none' = ordinary progress"),
        },
    }, async (args) => {
        const response = await handlers.reportProgress(args.progress, args.attention ?? 'none');
        logger.debug('[happyMCP] report_progress response:', response);
        if (response.accepted) {
            return { content: [{ type: 'text', text: 'Board updated.' }], isError: false };
        }
        // 被节流不是错误——告诉它「收到但没写」，别让它重试
        return {
            content: [{ type: 'text', text: response.error || 'Report skipped (reported too recently); no need to retry.' }],
            isError: false,
        };
    });

    if (options?.assistant) {
        registerAssistantTools(mcp);
    }

    return mcp;
}

export async function startHappyServer(client: ApiSessionClient, options?: StartHappyServerOptions) {
    logger.debug(`[happyMCP] server:start sessionId=${client.sessionId} assistant=${!!options?.assistant}`);

    const selfReportState = options?.selfReportState ?? createSelfReportState();

    const handlers: HappyMcpHandlers = {
        openPreview: async (path: string, mode: 'file' | 'diff') => {
            // 这道闸必须在 CLI 侧（模型请求刚落地时），不能放 web——web 可绕过。
            const verdict = checkPreviewPath(path);
            if (verdict.deniedReason) {
                logger.debug(`[happyMCP] open_preview denied: ${verdict.deniedReason}`);
                return { delivered: false, error: verdict.deniedReason };
            }
            try {
                const result = client.pushFilePreview(verdict.resolved, mode);
                return { delivered: result.delivered, resolved: verdict.resolved, error: result.error };
            } catch (error) {
                return { delivered: false, error: String(error) };
            }
        },
        reportProgress: async (progress: string, attention: BoardAttention) => {
            const text = normalizeProgress(progress);
            if (!text) {
                return { accepted: false, error: 'progress must be a non-empty one-line string' };
            }
            const now = Date.now();
            // attention 跃迁绕过节流（review finding 4）：否则「开始干活 → 撞权限
            // 卡住」的第二条会被静默吞掉，而 analyzer 又被 15min 水位压着。
            if (!shouldAcceptSelfReport(selfReportState, now, attention)) {
                return { accepted: false };
            }
            // 只有被接受时才推进水位——否则疯狂刷就能把 analyzer 永久压制住
            selfReportState.lastAcceptedAt = now;
            selfReportState.lastAttention = attention;
            try {
                client.updateMetadata((metadata) => ({
                    ...metadata,
                    board: {
                        ...(metadata as { board?: Record<string, unknown> })?.board,
                        attention,
                        progress: text,
                        analyzedAt: now,
                        // ⚠️ 这个字段**到不了 web**：web 的 MetadataSchema.board 是普通
                        // zod object（非 passthrough），safeParse 会把它剥掉；而 web 下
                        // 一次写 metadata 又会用剥净的对象回写，把它从服务端也删掉。
                        // 留着是为了 daemon 侧日志/未来把字段加进 web schema 时能对上，
                        // **别拿它做 UI**（review finding 5：原注释声称能区分自报与
                        // haiku 猜的，不成立）。
                        source: 'self-report' as const,
                    },
                }));
                return { accepted: true };
            } catch (error) {
                return { accepted: false, error: String(error) };
            }
        },
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
        const mcp = createMcpServer(handlers, options);
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
        toolNames: [
            'change_title',
            CLIPBOARD_TOOL_NAME,
            PREVIEW_TOOL_NAME,
            REPORT_PROGRESS_TOOL_NAME,
            ...(options?.assistant ? ASSISTANT_TOOL_NAMES : []),
        ],
        stop: () => {
            logger.debug(`[happyMCP] server:stop sessionId=${client.sessionId}`);
            server.close();
        }
    }
}
