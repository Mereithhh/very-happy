import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { configuration } from '@/configuration';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { writeTeamScope } from './context';

/** Real MCP transports used by Claude HTTP and Codex's stdio bridge; no model or production account. */
describe('managed Teams MCP transport', () => {
    const previousUrl = configuration.serverUrl;
    const previousScope = process.env.VH_TEAM_SCOPE_FILE;
    let server: Server | undefined;
    let happy: Awaited<ReturnType<typeof startHappyServer>> | undefined;
    let client: Client | undefined;
    let directory: string | undefined;
    afterEach(async () => {
        await client?.close(); client = undefined;
        happy?.stop(); happy = undefined;
        if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
        (configuration as any).serverUrl = previousUrl;
        if (previousScope === undefined) delete process.env.VH_TEAM_SCOPE_FILE; else process.env.VH_TEAM_SCOPE_FILE = previousScope;
        if (directory) await rm(directory, { recursive: true, force: true });
    });
    for (const kind of ['claude-http', 'codex-stdio'] as const) {
        it(`${kind} lists and executes ordinary-session team tools with scope authority`, async () => {
            const requests: Array<{ path?: string; authorization?: string; scope?: string }> = [];
            server = createServer((request, response) => {
                requests.push({ path: request.url, authorization: request.headers.authorization, scope: request.headers['x-happy-team-token'] as string });
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ team: { id: 'team-probe', name: 'NATIVE_TEAMS_PROBE', tasks: [] }, credential: { token: 'never-display' } }));
            });
            await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
            const origin = `http://127.0.0.1:${(server.address() as any).port}`;
            (configuration as any).serverUrl = origin;
            const base = join(homedir(), 'code/github/skills/tmp/agent-teams-implementation/tests');
            await mkdir(base, { recursive: true });
            directory = await mkdtemp(join(base, 'transport-'));
            process.env.VH_TEAM_SCOPE_FILE = join(directory, 'scope.json');
            await writeTeamScope(process.env.VH_TEAM_SCOPE_FILE, { serverUrl: origin, scopeToken: 'probe-only-token', teamId: 'team-probe', botId: 'worker' });
            happy = await startHappyServer({ sessionId: 'ordinary-session' } as any);
            client = new Client({ name: 'teams-probe', version: '1' });
            if (kind === 'claude-http') await client.connect(new StreamableHTTPClientTransport(new URL(happy.url)));
            else await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'bin/very-happy-mcp.mjs'), '--url', happy.url], stderr: 'pipe' }));
            const listed = await client.listTools();
            expect(listed.tools.some(tool => tool.name === 'team_delegate')).toBe(true);
            expect(listed.tools.find(tool => tool.name === 'team_inspect')?.annotations?.readOnlyHint).toBe(true);
            expect(listed.tools.some(tool => tool.name === 'session_spawn')).toBe(false);
            const result = await client.callTool({ name: 'team_message', arguments: { taskId: 'task', body: 'probe', requestId: `probe-${kind}` } });
            expect(result.isError).toBe(false);
            expect(JSON.stringify(result)).not.toContain('never-display');
            expect(requests).toEqual([{ path: '/v1/teams/team-probe/agent', scope: 'probe-only-token', authorization: undefined }]);
            if (process.env.VH_TEAMS_NATIVE_PROBE === '1') {
                const prompt = 'Call the happy team_inspect tool exactly once. Return only the team name you receive. Do not use any other tools.';
                const args = kind === 'claude-http'
                    ? ['--no-session-persistence', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { happy: { type: 'http', url: happy.url } } }), '--tools', '', '--allowedTools', 'mcp__happy__team_inspect', '--print', prompt]
                    : ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', `mcp_servers.happy.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.happy.args=${JSON.stringify([join(process.cwd(), 'bin/very-happy-mcp.mjs'), '--url', happy.url])}`, prompt];
                const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
                    const child = spawn(kind === 'claude-http' ? 'claude' : 'codex', args, { cwd: directory, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
                    let stdout = '', stderr = '';
                    child.stdout.on('data', data => { stdout += data; });
                    child.stderr.on('data', data => { stderr += data; });
                    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Native model probe timed out')); }, 80_000);
                    child.on('error', error => { clearTimeout(timer); reject(error); });
                    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
                });
                expect(output.code, output.stderr.slice(-1500)).toBe(0);
                expect(output.stdout, output.stderr.slice(-7000)).toContain('NATIVE_TEAMS_PROBE');
                expect(requests).toHaveLength(2);
                expect(requests[1]).toEqual({ path: '/v1/teams/team-probe/agent', scope: 'probe-only-token', authorization: undefined });
            }

        }, 90_000);
    }
});
