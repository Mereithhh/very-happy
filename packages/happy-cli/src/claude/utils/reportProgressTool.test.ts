/**
 * B-556: report_progress reaches every managed runner with one schema.
 * Source assertions verified with scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PI_TEAMS_EXTENSION } from '@/teams/resources';
import { registerReportProgressTool } from './reportProgressTool';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');

describe('report_progress across runners', () => {
    it('schema offers optional phase next to progress/attention', () => {
        let spec: any;
        registerReportProgressTool({ registerTool: ((_name: string, s: unknown) => { spec = s; }) as any }, async () => ({ content: [], isError: false }));
        expect(Object.keys(spec.inputSchema)).toEqual(['progress', 'attention', 'phase']);
        expect(spec.inputSchema.phase.safeParse(undefined).success).toBe(true);
        expect(spec.inputSchema.phase.safeParse('testing').success).toBe(true);
    });
    it('Claude: in-process, advertised in toolNames; a report without phase drops the old one', () => {
        const source = read('./startHappyServer.ts');
        expect(source).toContain('registerReportProgressTool(mcp, async (args) => {');
        expect(source).toContain('            REPORT_PROGRESS_TOOL_NAME,\n');
        expect(source).toContain('...withoutPhase((metadata as { board?: Record<string, unknown> })?.board),');
        expect(source).toContain('if (!shouldAcceptSelfReport(selfReportState, now, attention, phase)) {');
    });
    it('Codex / Gemini / ACP: the stdio bridge forwards it by name and Codex auto-approves it', () => {
        expect(read('../../codex/happyMcpStdioBridge.ts')).toContain('registerReportProgressTool(server, async (args) => (await ensureHttpClient()).callTool({ name: REPORT_PROGRESS_TOOL_NAME, arguments: args }) as any);');
        expect(read('../../codex/utils/permissionHandler.ts')).toContain("'mcp__happy__report_progress',");
        // the bare-name list is gated by the elicitation's server, which runCodex passes through
        const runCodex = read('../../codex/runCodex.ts');
        expect(runCodex).toContain("permissionHandler.handleToolCall(params.callId, toolName, input, params.type === 'mcp' ? params.serverName : undefined)");
        expect(runCodex).toContain('[HAPPY_MCP_SERVER_NAME]: {');
    });
    it('pi: discovered over tools/list and exempt from the per-call confirmation', () => {
        expect(PI_TEAMS_EXTENSION).toContain("await rpc('tools/list', {})");
        expect(PI_TEAMS_EXTENSION).toContain("'change_title','report_progress'].includes(event.toolName)");
    });
});
