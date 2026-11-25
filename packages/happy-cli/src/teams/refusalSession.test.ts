/**
 * B-972b: the "same refusal 3 times → STOP" count lives per session, not per McpServer.
 * startHappyServer builds a new McpServer for every HTTP request (stateless transport), so these tests go through
 * the real HTTP endpoint with a fresh MCP client — and so a fresh HTTP request and server — for every call.
 * Mutation-checked: moving the count back into registerTeamsTools' closure fails the STOP / reset cases.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { configuration } from '@/configuration';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { writeTeamScope } from './context';

const MESSAGE = { taskId: 'task' };
const SUBMIT = { taskId: 'task', attemptId: 'a1', goalVersion: 1 };

describe('B-972b: repeat-refusal count is per session over the stateless HTTP endpoint', () => {
    const previousUrl = configuration.serverUrl;
    const previousScope = process.env.VH_TEAM_SCOPE_FILE;
    let teams: Server | undefined;
    const sessions: Array<Awaited<ReturnType<typeof startHappyServer>>> = [];
    let directory: string | undefined;
    let teamsCalls = 0;
    afterEach(async () => {
        for (const happy of sessions.splice(0)) happy.stop();
        if (teams) { teams.closeAllConnections(); await new Promise<void>(resolve => teams!.close(() => resolve())); teams = undefined; }
        (configuration as any).serverUrl = previousUrl;
        if (previousScope === undefined) delete process.env.VH_TEAM_SCOPE_FILE; else process.env.VH_TEAM_SCOPE_FILE = previousScope;
        if (directory) await rm(directory, { recursive: true, force: true });
        directory = undefined;
    });

    async function session(id: string) {
        if (!teams) {
            teamsCalls = 0;
            teams = createServer(async (request, response) => {
                for await (const _chunk of request) { /* drain */ }
                teamsCalls++;
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ team: { id: 'team-probe', name: 'probe', tasks: [] } }));
            });
            await new Promise<void>(resolve => teams!.listen(0, '127.0.0.1', resolve));
            const origin = `http://127.0.0.1:${(teams.address() as any).port}`;
            (configuration as any).serverUrl = origin;
            const base = join(homedir(), 'code/github/skills/tmp/agent-teams-implementation/tests');
            await mkdir(base, { recursive: true });
            directory = await mkdtemp(join(base, 'refusal-'));
            process.env.VH_TEAM_SCOPE_FILE = join(directory, 'scope.json');
            await writeTeamScope(process.env.VH_TEAM_SCOPE_FILE, { serverUrl: origin, scopeToken: 'probe-only-token', teamId: 'team-probe', botId: 'worker' });
        }
        const happy = await startHappyServer({ sessionId: id } as any);
        sessions.push(happy);
        let n = 0;
        // A new client per call: a new HTTP request, so startHappyServer builds a new McpServer for it.
        return async (name: string, args: Record<string, unknown>) => {
            const client = new Client({ name: 'refusal-probe', version: '1' });
            await client.connect(new StreamableHTTPClientTransport(new URL(happy.url)));
            try {
                const result = await client.callTool({ name, arguments: { requestId: `${id}-${n++}`, ...args } }) as { isError?: boolean; content: Array<{ text?: string }> };
                return { isError: result.isError === true, text: result.content.map(part => part.text ?? '').join('') };
            } finally { await client.close(); }
        };
    }

    it('the 3rd identical refusal in a row says STOP, each call on its own request', async () => {
        const call = await session('s1');
        const texts: string[] = [];
        for (let i = 0; i < 4; i++) texts.push((await call('team_message', MESSAGE)).text);
        expect(texts[0]).toContain('Missing body');
        expect(texts[0]).not.toContain('STOP');
        expect(texts[1]).not.toContain('STOP');
        expect(texts[2]).toContain('Refused 3 times in a row: STOP retrying team_message');
        expect(texts[3]).toContain('Refused 4 times in a row');
        expect(teamsCalls).toBe(0);
    }, 30_000);

    it('an accepted call in between resets the count', async () => {
        const call = await session('s1');
        await call('team_message', MESSAGE);
        await call('team_message', MESSAGE);
        expect((await call('team_message', { ...MESSAGE, body: 'ok' })).isError).toBe(false);
        expect(teamsCalls).toBe(1);
        expect((await call('team_message', MESSAGE)).text).not.toContain('STOP');
        expect((await call('team_message', MESSAGE)).text).not.toContain('STOP');
        expect((await call('team_message', MESSAGE)).text).toContain('Refused 3 times in a row');
    }, 30_000);

    it('a refusal of another tool counts on its own', async () => {
        const call = await session('s1');
        await call('team_message', MESSAGE);
        await call('team_message', MESSAGE);
        expect((await call('team_submit', SUBMIT)).text).not.toContain('STOP');
        expect((await call('team_submit', SUBMIT)).text).not.toContain('STOP');
        expect((await call('team_submit', SUBMIT)).text).toContain('STOP retrying team_submit');
        expect((await call('team_message', MESSAGE)).text).not.toContain('STOP');
    }, 30_000);

    it('two sessions do not share the count', async () => {
        const one = await session('s1');
        const two = await session('s2');
        await one('team_message', MESSAGE);
        await one('team_message', MESSAGE);
        expect((await two('team_message', MESSAGE)).text).not.toContain('STOP');
        expect((await one('team_message', MESSAGE)).text).toContain('Refused 3 times in a row');
        expect((await two('team_message', MESSAGE)).text).not.toContain('STOP');
    }, 30_000);
});
