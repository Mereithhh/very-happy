/**
 * `report_progress` registration, shared by every managed runner (B-556):
 * Claude registers it in-process (`startHappyServer`, advertised in
 * `toolNames` → SDK allowedTools); the Codex / Gemini / ACP stdio bridge
 * registers the same schema and forwards by name to that HTTP server; managed
 * pi discovers it over `HAPPY_MCP_URL` `tools/list`. Execution always happens
 * in the owning session process (throttle + `metadata.board` write live there).
 *
 * One schema in one place, so the bridge can never drift from the server.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { REPORT_PROGRESS_TOOL_DESCRIPTION, REPORT_PROGRESS_TOOL_NAME, REPORT_PROGRESS_TOOL_TITLE } from './agentGuidance';
import { BOARD_PHASES } from './boardReport';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError: boolean };
export type ReportProgressExecutor = (args: { progress?: unknown; attention?: unknown; phase?: unknown }) => Promise<ToolResult>;

export function registerReportProgressTool(server: Pick<McpServer, 'registerTool'>, execute: ReportProgressExecutor): void {
    server.registerTool(REPORT_PROGRESS_TOOL_NAME, {
        description: REPORT_PROGRESS_TOOL_DESCRIPTION,
        title: REPORT_PROGRESS_TOOL_TITLE,
        inputSchema: {
            progress: z.string().describe('One short line describing the current state of this task'),
            attention: z.enum(['none', 'review', 'blocked']).optional()
                .describe("'blocked' = cannot proceed without the user; 'review' = wants their eyes; 'none' = ordinary progress"),
            phase: z.enum(BOARD_PHASES).optional()
                .describe('Optional phase of the work, shown as a label next to the progress line'),
        },
    }, async (args: any) => {
        try { return await execute(args ?? {}); }
        catch (error) {
            return { content: [{ type: 'text' as const, text: `Failed to report progress: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
    });
}
