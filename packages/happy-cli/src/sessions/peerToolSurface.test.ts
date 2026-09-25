/**
 * B-497 regression: session_message / session_peers reach all three managed
 * runners the same way the automation tools do (B-496 pattern):
 *  - Claude: registered in-process by startHappyServer with the session's own
 *    identity, and advertised in toolNames (→ SDK allowedTools).
 *  - Codex: the stdio bridge forwards them by name, no new literal registerTool(.
 *  - pi: dynamic tools/list registration over HAPPY_MCP_URL.
 * Source assertions verified with scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PI_TEAMS_EXTENSION } from '@/teams/resources';
import { SESSION_PEER_TOOL_NAMES } from './peerTools';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');

describe('session peer tool surface across runners', () => {
    it('is registered in-process for managed Claude with the session identity and advertised in toolNames', () => {
        const source = read('../claude/utils/startHappyServer.ts');
        expect(source).toContain('if (client) registerSessionPeerTools(mcp, createSessionPeerToolExecutor(client));');
        expect(source).toContain('...SESSION_PEER_TOOL_NAMES,');
        expect(source).toContain('createMcpServer(handlers, options, client.sessionId, client)');
        expect(source.indexOf('registerSessionPeerTools(mcp')).toBeLessThan(source.indexOf("mcp.registerTool('change_title'"));
    });
    it('is forwarded by the Codex stdio bridge without new literal registrations', () => {
        const source = read('../codex/happyMcpStdioBridge.ts');
        expect(source).toContain('registerSessionPeerTools(server, (name, args) => forwardTeam(name, args));');
        expect(source.match(/registerTool\(/g)).toHaveLength(3);
    });
    it('reaches managed pi through dynamic tools/list registration over HAPPY_MCP_URL', () => {
        expect(PI_TEAMS_EXTENSION).toContain("await rpc('tools/list', {})");
        expect(PI_TEAMS_EXTENSION).toContain('pi.registerTool({name:tool.name');
    });
    it('every runner reports its edit calls to the daemon', () => {
        expect(read('../claude/runClaude.ts')).toContain('reportSessionEditToDaemon({ sessionId: response.id, path: edit.path, tool: edit.tool, cwd: workingDirectory });');
        expect(read('../codex/runCodex.ts')).toContain('editThrottle.take(extractCodexPatchPaths(changes))');
        expect(read('../agent/acp/runAcp.ts')).toContain('editThrottle.take(extractAcpEditPaths(msg.toolName, msg.args))');
        expect(read('../mirror/mirrorManager.ts')).toContain('deps.onEdit({ sessionId: binding.happySessionId, path: edit.path, tool: edit.tool, cwd: binding.metadata.path });');
    });
    it('keeps the documented matrix in sync', () => {
        const channels = readFileSync(new URL('../../../../docs/channels.md', import.meta.url), 'utf8');
        for (const name of SESSION_PEER_TOOL_NAMES) expect(channels).toContain(name);
        expect(channels).toContain('very-happy sessions peers');
        expect(channels).toContain('very-happy sessions message');
    });
});
