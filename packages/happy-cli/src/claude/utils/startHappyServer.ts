import { registerProjectTools, createProjectToolExecutor, PROJECT_TOOL_NAMES } from '@/projects/tools';
import { PiContextReportSchema, type PiContextReport } from '@/agent/acp/piContextUsage';
/**
 * Happy MCP server
 * Provides Happy CLI specific tools including chat session title management
 *
 * Uses stateless StreamableHTTP: each request gets a fresh McpServer + transport.
 * This is required by MCP SDK >=1.27 which rejects reuse of an already-connected transport.
 */

import { createTeamAdoption, TEAMS_ADOPT_CAPABILITY } from '@/teams/adopt';
import { registerTeamsTools, TEAM_TOOL_NAMES } from '@/teams/tools';
import { registerAutomationTools, AUTOMATION_TOOL_NAMES } from '@/automations/tools';
import { registerSessionPeerTools, createSessionPeerToolExecutor, SESSION_PEER_TOOL_NAMES } from '@/sessions/peerTools';
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
    PREVIEW_DOWNLOAD_PARAM_DESCRIPTION, PREVIEW_TOOL_DESCRIPTION, PREVIEW_TOOL_NAME, PREVIEW_TOOL_TITLE,
    REPORT_PROGRESS_TOOL_NAME,
} from "./agentGuidance";
import {
    type BoardAttention, type BoardPhase, type SelfReportState,
    createSelfReportState, normalizeAttention, normalizePhase, normalizeProgress, shouldAcceptSelfReport,
} from "./boardReport";
import { registerReportProgressTool } from "./reportProgressTool";
import { createRequestHuman, REQUEST_HUMAN_TOOL_DESCRIPTION, REQUEST_HUMAN_TOOL_NAME, requestHumanResultText, type RequestHumanResult } from "./requestHuman";
import { readSettings } from "@/persistence";
import { getSessionNotificationBody } from "@/api/pushNotifications";
import { checkPreviewPath } from "./previewPath";
import { checkDownloadTarget } from "./downloadTarget";

interface HappyMcpHandlers {
    changeTitle: (title: string) => Promise<{ success: boolean; error?: string }>;
    copyToClipboard: (text: string) => Promise<{ delivered: boolean; truncated: boolean; totalBytes: number; error?: string }>;
    /** B-131: ask the user's web clients to open a file preview. */
    openPreview: (path: string, mode: 'file' | 'diff', download?: boolean) => Promise<{ delivered: boolean; resolved?: string; error?: string; note?: string }>;
    /** B-132: claude self-reports progress onto the task board. */
    reportProgress: (progress: string, attention: BoardAttention, phase?: BoardPhase) => Promise<{ accepted: boolean; error?: string }>;
    /** B-510: ask a person to step in (push + board blocked). */
    requestHuman: (reason: string, panel?: string) => Promise<RequestHumanResult>;
}

export interface StartHappyServerOptions {
    /** B-727: the pi extension's raw report; the wrapper resolves it into `agentState.contextUsage`. */
    onContextUsage?: (report: PiContextReport) => void;
    /** B-632: pi steer channel served at the returned `steerUrl`. */
    piSteer?: import('@/agent/acp/piSteerChannel').PiSteerChannel;
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
    /** B-510: push client for `request_human` (absent → the tool only marks the board). */
    push?: { sendAttention: (input: { sessionId: string; reason: string; url: string; sessionTitle?: string }) => Promise<{ sent: boolean; kind?: string; error?: string }> };
}

function createMcpServer(handlers: HappyMcpHandlers, options?: StartHappyServerOptions, sessionId?: string, client?: ApiSessionClient): McpServer {
    const mcp = new McpServer({
        name: "Very Happy Tools",
        version: "1.0.0",
    });

    registerTeamsTools(mcp, sessionId);
    // B-496: account-level automations, same trust level as the session itself.
    registerAutomationTools(mcp);
    // B-497: message / list the other sessions on this machine (identity = this session).
    if (client) registerSessionPeerTools(mcp, createSessionPeerToolExecutor(client));
    // B-645: project_context / project_note — always registered (a fixed tools prefix); "not in a project" otherwise.
    if (client) registerProjectTools(mcp, createProjectToolExecutor(() => client.sessionId));

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
                    text: `Queued a clipboard request for the user's open Very Happy device(s)${note}. This does not confirm that a browser wrote the clipboard; the user may need to tap a confirmation button.`,
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
            // B-562: optional; old web clients ignore the resulting intent and just preview.
            download: z.boolean().optional().describe(PREVIEW_DOWNLOAD_PARAM_DESCRIPTION),
        },
    }, async (args) => {
        const response = await handlers.openPreview(args.path, args.mode ?? 'file', args.download === true);
        logger.debug('[happyMCP] open_preview response:', response);
        if (response.delivered) {
            const target = response.resolved ?? args.path;
            return {
                content: [{
                    type: 'text',
                    // 明说不保证用户看到了——否则 claude 会基于「已预览」做后续推断（spec 风险 8）
                    text: (args.download === true
                        ? `Asked the user's open web client(s) to offer ${target} for download. This does not confirm they downloaded it.`
                        : `Asked the user's open web client(s) to preview ${target}. This does not confirm they looked at it.`)
                        + (response.note ? ` ${response.note}` : ''),
                }],
                isError: false,
            };
        }
        return {
            content: [{ type: 'text', text: `Could not open preview: ${response.error || 'unknown error'}` }],
            isError: true,
        };
    });

    // B-510 request_human —— board blocked + push-event `attention` (panel deep link).
    mcp.registerTool(REQUEST_HUMAN_TOOL_NAME, {
        description: REQUEST_HUMAN_TOOL_DESCRIPTION,
        title: 'Ask the user to step in',
        inputSchema: {
            reason: z.string().describe('What you need from the user, one short line (no secrets)'),
            panel: z.string().optional().describe("Id of this machine's web panel that shows what you are working in (from ~/.happy/settings.json webPanels)"),
        },
    }, async (args) => {
        const response = await handlers.requestHuman(String(args.reason ?? ''), args.panel);
        logger.debug('[happyMCP] request_human response:', response);
        return { content: [{ type: 'text', text: requestHumanResultText(response) }], isError: response.error === 'reason must be a non-empty string' };
    });

    // B-132 report_progress —— 写 session metadata 的 board 字段，复用既有 sessions push。
    // B-556: the schema (incl. optional phase) lives in reportProgressTool.ts, shared with the stdio bridge.
    registerReportProgressTool(mcp, async (args) => {
        const response = await handlers.reportProgress(String(args.progress ?? ''), normalizeAttention(args.attention), normalizePhase(args.phase));
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

    if (options?.assistant && !process.env.VH_TEAM_SCOPE_FILE) {
        registerAssistantTools(mcp);
    }

    return mcp;
}

function withoutPhase(board: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!board) return {};
    const { phase: _phase, ...rest } = board;
    return rest;
}

export async function startHappyServer(client: ApiSessionClient, options?: StartHappyServerOptions) {
    logger.debug(`[happyMCP] server:start sessionId=${client.sessionId} assistant=${!!options?.assistant}`);

    const selfReportState = options?.selfReportState ?? createSelfReportState();

    const handlers: HappyMcpHandlers = {
        openPreview: async (path: string, mode: 'file' | 'diff', download = false) => {
            // 这道闸必须在 CLI 侧（模型请求刚落地时），不能放 web——web 可绕过。
            const verdict = checkPreviewPath(path);
            if (verdict.deniedReason) {
                logger.debug(`[happyMCP] open_preview denied: ${verdict.deniedReason}`);
                return { delivered: false, error: verdict.deniedReason };
            }
            // B-562: a download must be one existing regular file (directories → zip first).
            const target = download ? await checkDownloadTarget(verdict.resolved) : null;
            if (target?.error) return { delivered: false, error: target.error };
            try {
                const result = client.pushFilePreview(verdict.resolved, mode, download ? 'download' : undefined);
                return { delivered: result.delivered, resolved: verdict.resolved, error: result.error, note: target?.note ?? undefined };
            } catch (error) {
                return { delivered: false, error: String(error) };
            }
        },
        reportProgress: async (progress: string, attention: BoardAttention, phase?: BoardPhase) => {
            const text = normalizeProgress(progress);
            if (!text) {
                return { accepted: false, error: 'progress must be a non-empty one-line string' };
            }
            const now = Date.now();
            // attention 跃迁绕过节流（review finding 4）：否则「开始干活 → 撞权限
            // 卡住」的第二条会被静默吞掉，而 analyzer 又被 15min 水位压着。
            if (!shouldAcceptSelfReport(selfReportState, now, attention, phase)) {
                return { accepted: false };
            }
            // 只有被接受时才推进水位——否则疯狂刷就能把 analyzer 永久压制住
            selfReportState.lastAcceptedAt = now;
            selfReportState.lastAttention = attention;
            selfReportState.lastPhase = phase;
            try {
                client.updateMetadata((metadata) => ({
                    ...metadata,
                    board: {
                        // B-556: a report without phase must not keep the previous one
                        // (a stale label next to fresh text); taskId etc. are kept.
                        ...withoutPhase((metadata as { board?: Record<string, unknown> })?.board),
                        ...(phase ? { phase } : {}),
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
        requestHuman: createRequestHuman({
            sessionId: client.sessionId,
            machineId: () => client.getMetadata()?.machineId,
            readPanels: async () => (await readSettings()).webPanels,
            // Same board write (and attention-change throttle bypass) as report_progress.
            reportBlocked: (reason) => handlers.reportProgress(reason, 'blocked'),
            sendAttention: (input) => options?.push
                ? options.push.sendAttention({ ...input, sessionTitle: getSessionNotificationBody(client.getMetadata()) })
                : Promise.resolve({ sent: false, error: 'push is not available in this runner' }),
        }),
    };

    const contextPath = '/runtime-context/' + randomUUID();
    // B-632: pi steer channel (agent/acp/piSteerChannel.ts) — long poll + hello + ack.
    const steerPath = '/runtime-steer/' + randomUUID();
    const server = createServer(async (req, res) => {
        if (req.url?.startsWith('/runtime-steer/')) {
            const steer = options?.piSteer;
            if (!steer || req.headers.origin) { res.writeHead(403).end(); return; }
            if (req.method === 'GET' && req.url === steerPath) {
                const gone = new AbortController();
                res.on('close', () => gone.abort());
                const item = await steer.take(25_000, gone.signal);
                if (res.writableEnded || gone.signal.aborted) {
                    // The poller left: its message goes back to the wrapper's own deadline.
                    return;
                }
                if (!item) { res.writeHead(204).end(); return; }
                res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(item));
                return;
            }
            if (req.method === 'POST' && (req.url === steerPath + '/hello' || req.url === steerPath + '/ack')) {
                let body = '';
                for await (const chunk of req) {
                    body += chunk.toString();
                    if (Buffer.byteLength(body) > 1024) { res.writeHead(413).end(); return; }
                }
                if (req.url.endsWith('/hello')) { steer.hello(); res.writeHead(204).end(); return; }
                try {
                    const ack = JSON.parse(body) as { id?: unknown; delivered?: unknown };
                    if (typeof ack.id !== 'number') throw new Error('id');
                    steer.ack(ack.id, ack.delivered === true);
                    res.writeHead(204).end();
                } catch { res.writeHead(400).end(); }
                return;
            }
            res.writeHead(403).end();
            return;
        }
        if (req.url?.startsWith('/runtime-context/')) {
            if (!options?.onContextUsage || req.url !== contextPath || req.method !== 'POST' || req.headers.origin) {
                res.writeHead(403).end(); return;
            }
            try {
                let body = '';
                for await (const chunk of req) {
                    body += chunk.toString();
                    if (Buffer.byteLength(body) > 4096) { res.writeHead(413).end(); return; }
                }
                options.onContextUsage(PiContextReportSchema.parse(JSON.parse(body)));
                res.writeHead(204).end();
            } catch { if (!res.headersSent) res.writeHead(400).end(); }
            return;
        }
        const mcp = createMcpServer(handlers, options, client.sessionId, client);
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

    const adoptionEnabled = !process.env.VH_TEAM_SCOPE_FILE;
    if (adoptionEnabled) {
        client.rpcHandlerManager.registerHandler('teams-adopt', createTeamAdoption(client.sessionId));
        client.updateMetadata(metadata => ({ ...metadata, capabilities: [...new Set([...(metadata.capabilities ?? []), TEAMS_ADOPT_CAPABILITY])] }));
    }

    logger.debug(`[happyMCP] server:ready sessionId=${client.sessionId} url=${baseUrl.toString()}`);

    return {
        url: baseUrl.toString(),
        contextUsageUrl: options?.onContextUsage ? new URL(contextPath, baseUrl).toString() : undefined,
        steerUrl: options?.piSteer ? new URL(steerPath, baseUrl).toString() : undefined,
        toolNames: [
            'change_title',
            CLIPBOARD_TOOL_NAME,
            PREVIEW_TOOL_NAME,
            REPORT_PROGRESS_TOOL_NAME,
            REQUEST_HUMAN_TOOL_NAME,
            ...TEAM_TOOL_NAMES,
            ...AUTOMATION_TOOL_NAMES,
            ...SESSION_PEER_TOOL_NAMES,
            ...PROJECT_TOOL_NAMES,
            ...(options?.assistant && !process.env.VH_TEAM_SCOPE_FILE ? ASSISTANT_TOOL_NAMES : []),
        ],
        stop: () => {
            logger.debug(`[happyMCP] server:stop sessionId=${client.sessionId}`);
            if (adoptionEnabled) client.rpcHandlerManager.unregisterHandler('teams-adopt');
            server.close();
        }
    }
}
