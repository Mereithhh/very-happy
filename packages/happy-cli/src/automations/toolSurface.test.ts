/**
 * B-496 regression: the automation_* tools reach all three managed runners.
 *  - Claude: registered in-process by startHappyServer (and advertised in toolNames).
 *  - Codex: the stdio bridge forwards them by name to that HTTP server, without
 *    a second literal `registerTool(` (the web public contract pins that count).
 *  - pi: the managed extension registers whatever `tools/list` returns over
 *    HAPPY_MCP_URL, so no per-tool wiring exists to forget.
 * Source assertions verified with scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PI_TEAMS_EXTENSION } from '@/teams/resources';
import { AUTOMATION_TOOL_NAMES } from './tools';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');

describe('automation tool surface across runners', () => {
    it('is registered in-process for managed Claude and advertised in toolNames', () => {
        const source = read('../claude/utils/startHappyServer.ts');
        expect(source).toContain('registerAutomationTools(mcp);');
        expect(source).toContain('...AUTOMATION_TOOL_NAMES,');
        expect(source.indexOf('registerAutomationTools(mcp);')).toBeLessThan(source.indexOf("mcp.registerTool('change_title'"));
    });
    it('is forwarded by the Codex stdio bridge without new literal registrations', () => {
        const source = read('../codex/happyMcpStdioBridge.ts');
        expect(source).toContain('registerAutomationTools(server, (name, args) => forwardTeam(name, args));');
        expect(source.match(/registerTool\(/g)).toHaveLength(3);
    });
    it('reaches managed pi through dynamic tools/list registration over HAPPY_MCP_URL', () => {
        expect(PI_TEAMS_EXTENSION).toContain("await rpc('tools/list', {})");
        expect(PI_TEAMS_EXTENSION).toContain('pi.registerTool({name:tool.name');
    });
    it('keeps the documented matrix in sync', () => {
        const channels = readFileSync(new URL('../../../../docs/channels.md', import.meta.url), 'utf8');
        for (const name of AUTOMATION_TOOL_NAMES) expect(channels).toContain(name);
        expect(channels).toContain('very-happy auto');
    });
});
