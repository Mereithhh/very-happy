import { registerProjectTools, createProjectToolExecutor, PROJECT_TOOL_NAMES } from '@/projects/tools';
import { registerIssueTools, createIssueToolExecutor, ISSUE_TOOL_NAMES } from '@/issues/tools';
import { registerIdleRestartTool, idleRestartToolResult, IDLE_RESTART_TOOL_NAMES } from '@/sessions/idleRestartTool';
import { requestIdleRestartViaDaemon } from '@/daemon/controlClient';
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
import { registerSessionPeerTools, createSessionPeerContext, createSessionPeerToolExecutor, sendPeerMessage, SESSION_PEER_TOOL_NAMES } from '@/sessions/peerTools';
import { createWrapupTracker } from '@/wrapup/tracker';
import { executeWrapupTool, registerWrapupTools, WRAPUP_TOOL_NAMES, type WrapupToolExecutor } from '@/wrapup/tools';
import { archiveSession } from '@/sessions/sessionOps';
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
import { ATTENTION_SESSION_CAPABILITY, WRAPUP_SESSION_CAPABILITY } from "@slopus/happy-wire";
import { sharedAttentionClient } from "@/attention/client";
import { attachLeadBoard, createLeadBoard, resolveTeamLead } from "@/attention/leadBoard";
import { OWNER_BOARD_TOOL_NAMES, registerOwnerBoardTools } from "@/attention/tools";
import { DISPATCH_APPROVED_TOOL } from "@/assistant/gates/dispatchGate";
import type { MainAgentRuntime } from "@/assistant/gates/setup";
import { withToolOutputCaps } from "@/assistant/toolCaps";
import { MAIN_AGENT_LIST_VIEWS } from "@/assistant/listViews";
import { installSessionLifecycle, MAIN_AGENT_REPLACES, MAIN_AGENT_TOOL_NAMES, registerMainAgentTools } from "@/assistant/mainAgentTools";
import { createLiveMainAgentLifecycle } from "@/assistant/mainAgentLifecycle";
import { createMainAgentDeps } from "@/assistant/mainAgentDeps";

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
    /**
     * B-916c: main agent runtime (assistant variant, no team scope). Its gate
     * wraps the registrar so dispatch tools take `risk` and park non-none
     * calls on the decision board; `dispatch_approved` runs them.
     */
    mainAgent?: MainAgentRuntime;
    /** B-510: push client for `request_human` (absent → the tool only marks the board). */
    push?: { sendAttention: (input: { sessionId: string; reason: string; url: string; sessionTitle?: string }) => Promise<{ sent: boolean; kind?: string; error?: string }> };
}

/** B-766: the first `tools/list` waits this long for the board probe, so a lead sees `owner_board_*` from its first turn. */
const OWNER_BOARD_READY_MS = 3_000;

/** B-766: raw Claude assistant line → its text blocks (main thread only). */
function assistantTexts(body: unknown): string[] {
    const line = body as { type?: string; isSidechain?: boolean; message?: { content?: unknown } };
    if (line?.type !== 'assistant' || line.isSidechain || !Array.isArray(line.message?.content)) return [];
    return line.message!.content
        .filter((block: any) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim())
        .map((block: any) => block.text as string);
}

/**
 * B-916b: the main agent = the assistant variant outside any team scope (the
 * B-051 condition). Only it gets the account-level tools and the output caps.
 */
export function isMainAgentSession(options?: StartHappyServerOptions, env: NodeJS.ProcessEnv = process.env): boolean {
    // B-916c (QA77 #6): only a runner that brings the gates (Claude: runClaude builds `mainAgent`)
    // gets the account-level surface. A pi/ACP assistant keeps the plain B-051 tools.
    return options?.assistant === true && !env.VH_TEAM_SCOPE_FILE && options.mainAgent !== undefined;
}

/** B-051 assistant without the main agent runtime (pi / ACP): legacy session tools only, no caps, no account tools. */
function isLegacyAssistantSession(options?: StartHappyServerOptions, env: NodeJS.ProcessEnv = process.env): boolean {
    return options?.assistant === true && !env.VH_TEAM_SCOPE_FILE && options.mainAgent === undefined;
}

function createMcpServer(handlers: HappyMcpHandlers, options?: StartHappyServerOptions, sessionId?: string, client?: ApiSessionClient, wrapup?: WrapupToolExecutor): McpServer {
    const server = new McpServer({
        name: "Very Happy Tools",
        version: "1.0.0",
    });
    const mainAgent = isMainAgentSession(options);
    // B-916b: on the main agent every answer is capped (receipt 400 / list 4K / body 8K); other sessions unchanged.
    const mcp = mainAgent ? withToolOutputCaps(server, MAIN_AGENT_LIST_VIEWS) : server;
    // The main agent's account-level versions replace these session-scoped ones (mainAgentTools.ts).
    const replaced = mainAgent ? MAIN_AGENT_REPLACES : [];

    // B-916c gate 2: the main agent's dispatch tools go through the gate (adds `risk`, parks non-none calls).
    const dispatchRegistrar = mainAgent ? options!.mainAgent!.gate.wrap(mcp) : mcp;
    registerTeamsTools(dispatchRegistrar, sessionId);
    // B-496: account-level automations, same trust level as the session itself.
    registerAutomationTools(dispatchRegistrar);
    // B-497: message / list the other sessions on this machine (identity = this session).
    if (client) registerSessionPeerTools(dispatchRegistrar, createSessionPeerToolExecutor(client));
    // B-645: project_context / project_note — always registered (a fixed tools prefix); "not in a project" otherwise.
    if (client) registerProjectTools(mcp, createProjectToolExecutor(() => client.sessionId), replaced);
    // B-874: issue_get / issue_update / issue_comment / issue_list — always registered; "issue_not_bound" outside an issue run.
    if (client) registerIssueTools(mcp, createIssueToolExecutor(() => client.sessionId), replaced);
    // B-911: the agent asks the daemon to restart its own session once idle (the daemon matches this wrapper's pid).
    if (client) registerIdleRestartTool(mcp, async () => idleRestartToolResult(await requestIdleRestartViaDaemon(client.sessionId, process.pid)));
    // B-915: wrapup_report / handoff_send / session_wrapup / session_handoff — every session.
    // Rebase onto B-916b: the main agent registers its own session_wrapup / session_handoff (mainAgentTools.ts),
    // so on its surface only wrapup_report / handoff_send come from here (a second registration throws).
    if (wrapup) registerWrapupTools(mcp, wrapup, mainAgent ? MAIN_AGENT_TOOL_NAMES : []);

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

    if (mainAgent) {
        registerAssistantTools(dispatchRegistrar);
        // B-916b: issues / todos / projects / Lead dispatch / lifecycle adapters (no shell on this surface).
        // B-916c: through the gate, so lead_delegate / lead_message take `risk` too.
        if (client) registerMainAgentTools(dispatchRegistrar, createMainAgentDeps(() => client.sessionId));
        if (options?.mainAgent) options.mainAgent.gate.registerApprovedTool(mcp);
    } else if (isLegacyAssistantSession(options)) {
        registerAssistantTools(mcp);
    }

    return server;
}

function withoutPhase(board: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!board) return {};
    const { phase: _phase, ...rest } = board;
    return rest;
}

export async function startHappyServer(client: ApiSessionClient, options?: StartHappyServerOptions) {
    logger.debug(`[happyMCP] server:start sessionId=${client.sessionId} assistant=${!!options?.assistant}`);

    const selfReportState = options?.selfReportState ?? createSelfReportState();
    // B-919: the main agent's session_wrapup / session_handoff / session_restart run on the B-915 / B-911 backends.
    const mainAgentLifecycle = isMainAgentSession(options);
    if (mainAgentLifecycle) installSessionLifecycle(createLiveMainAgentLifecycle(() => client.sessionId));

    // B-766 C-1: briefing board — probe, lead check, owner-question / first-reply / D5 fallbacks.
    const leadBoard = createLeadBoard({
        sessionId: () => client.sessionId,
        client: sharedAttentionClient(),
        isLead: () => resolveTeamLead(client.sessionId),
        autoDetect: async () => (await readSettings()).ownerBoardAutoDetect !== false,
        // B-915: `wrapup-v1` rides on the board: its cards need the board, its tools are always registered.
        onSupported: () => client.updateMetadata(metadata => ({ ...metadata, capabilities: [...new Set([...(metadata.capabilities ?? []), ATTENTION_SESSION_CAPABILITY, WRAPUP_SESSION_CAPABILITY])] })),
        log: (message) => logger.debug(message),
        ...(isMainAgentSession(options) ? { postSource: 'agent' as const } : {}),
    });
    attachLeadBoard(client, leadBoard);
    void leadBoard.init();
    // B-915 「收尾」/「交接给…」: running cards, the report / handoff tools, archive after a confirmed handoff.
    const peerContext = createSessionPeerContext(client);
    const wrapupTracker = createWrapupTracker({
        sessionId: () => client.sessionId,
        client: sharedAttentionClient(),
        boardReady: async () => { await leadBoard.init(); return leadBoard.supported(); },
        sendPeer: (args) => sendPeerMessage(peerContext, args),
        archiveSelf: (id) => archiveSession(id),
        log: (message) => logger.debug(message),
    });
    const wrapupTools: WrapupToolExecutor = (name, args) => executeWrapupTool(name, args, { selfId: () => client.sessionId, tracker: wrapupTracker });
    const onRoutedUserMessage = (event: { localId?: string | null; message?: { content?: { text?: unknown }; meta?: { sentFrom?: string; delivery?: string } } }) => {
        const text = event.message?.content?.text;
        leadBoard.onUserMessage({ localId: event.localId, text: typeof text === 'string' ? text : null, sentFrom: event.message?.meta?.sentFrom, delivery: event.message?.meta?.delivery });
        wrapupTracker.onUserMessage({ localId: event.localId });
    };
    const onClaudeLine = (body: unknown) => { for (const text of assistantTexts(body)) leadBoard.onAssistantText(text); };
    const onTurnStarted = (sourceIds?: string[]) => { wrapupTracker.onTurnStart(sourceIds); };
    const onTurnEnded = () => { void leadBoard.onTurnEnd(); void wrapupTracker.onTurnEnd(); };
    // Codex / pi / Gemini end a turn with a `ready` event and never emit `turn-ended`.
    const onAgentReady = () => { void wrapupTracker.onTurnEnd(); };
    // Test doubles of the session client are not always emitters.
    const tapped = typeof client.on === 'function';
    if (tapped) {
        client.on('user-message-routed', onRoutedUserMessage);
        client.on('claude-session-message', onClaudeLine);
        client.on('turn-started', onTurnStarted);
        client.on('turn-ended', onTurnEnded);
        client.on('agent-ready', onAgentReady);
    }

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
            logger.debug(`[happyMCP] Changing title (${title.length} chars)`); // B-874c: titles carry issue text
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
            postBlocked: (reason, panel) => leadBoard.postBlocked(reason, panel),
        }),
    };

    const contextPath = '/runtime-context/' + randomUUID();
    // B-632: pi steer channel (agent/acp/piSteerChannel.ts) — long poll + hello + ack.
    const steerPath = '/runtime-steer/' + randomUUID();
    // B-916b: the main agent's owner_board_* appear once the server is known to serve the board (then stay).
    let mainAgentBoard = false;
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
        await leadBoard.ready(OWNER_BOARD_READY_MS);
        const mcp = createMcpServer(handlers, options, client.sessionId, client, wrapupTools);
        // B-766: owner briefing board, team lead on a server that serves it (decided once per process).
        // B-916b: also the main agent (capped like the rest of its surface) once the server serves the board.
        if (isMainAgentSession(options)) {
            mainAgentBoard ||= leadBoard.supported();
            // B-916c (QA77 #2): through the gate's registrar, which refuses writes to the gate's own decision cards.
            if (mainAgentBoard) registerOwnerBoardTools(options!.mainAgent!.gate.wrap(withToolOutputCaps(mcp, MAIN_AGENT_LIST_VIEWS)), leadBoard);
        } else if (leadBoard.toolsExposed()) registerOwnerBoardTools(mcp, leadBoard);
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
            ...ISSUE_TOOL_NAMES,
            ...IDLE_RESTART_TOOL_NAMES,
            ...WRAPUP_TOOL_NAMES,
            // Auto-allow only; the tools themselves appear for a lead on a board server.
            ...OWNER_BOARD_TOOL_NAMES,
            ...(isMainAgentSession(options) ? [...ASSISTANT_TOOL_NAMES, ...MAIN_AGENT_TOOL_NAMES, DISPATCH_APPROVED_TOOL] : []),
            ...(isLegacyAssistantSession(options) ? ASSISTANT_TOOL_NAMES : []),
        ],
        leadBoard,
        stop: () => {
            logger.debug(`[happyMCP] server:stop sessionId=${client.sessionId}`);
            if (mainAgentLifecycle) installSessionLifecycle(null);
            if (adoptionEnabled) client.rpcHandlerManager.unregisterHandler('teams-adopt');
            if (tapped) {
                client.off('user-message-routed', onRoutedUserMessage);
                client.off('claude-session-message', onClaudeLine);
                client.off('turn-started', onTurnStarted);
                client.off('turn-ended', onTurnEnded);
                client.off('agent-ready', onAgentReady);
            }
            server.close();
        }
    }
}
