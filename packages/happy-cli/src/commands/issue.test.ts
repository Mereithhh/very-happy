import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'https://relay.example' } }));
vi.mock('@/persistence', () => ({ readSettings: vi.fn(async () => ({ machineId: 'local-m' })) }));
vi.mock('@/teams/context', () => ({ readTeamScope: vi.fn(async () => null), teamScopePath: vi.fn(() => '/scope') }));
import { IssueRequestError } from '@/issues/client';
import { agentSessionId, parseAssign, parseIssueArgs, runIssueCommand } from './issue';

const issue = (over: Record<string, unknown> = {}) => ({
    id: 'i1', number: 4, key: 'VH-4', title: 'T', description: '', status: 'in_progress', priority: 'none', assignee: { kind: 'none' }, projectId: null,
    labels: [], dueAt: null, parentId: null, sortOrder: 0, createdBy: { kind: 'user' }, statusRunId: null, latestRunId: null, legacyTodoId: null,
    createdAt: 1, updatedAt: 1, statusChangedAt: 1, startedAt: null, completedAt: null, deletedAt: null, version: 1, ...over,
});
const api = () => ({
    isDisabled: () => false, importLegacyTodos: vi.fn(async () => ({})),
    list: vi.fn(async () => ({ issues: [issue()], nextCursor: null, asOf: 1 })),
    get: vi.fn(async () => ({ issue: issue(), comments: [], runs: [], children: [] })),
    create: vi.fn(async (input: any) => ({ issue: issue({ title: input.title }), runs: [] })),
    update: vi.fn(async () => ({ issue: issue() })), comment: vi.fn(async () => ({ issue: issue(), comment: { routedRunIds: [] } })),
    session: vi.fn(async () => ({ issue: issue(), run: null, current: true, comments: [], asOf: 1 })),
    agentUpdate: vi.fn(async () => ({ issue: issue({ status: 'in_review' }) })), agentComment: vi.fn(async () => ({ issue: issue() })),
});
const run = (args: string[], client: ReturnType<typeof api>, env: NodeJS.ProcessEnv = {}) => runIssueCommand(parseIssueArgs(args), { client: client as any, env });

describe('very-happy issue (spec §11)', () => {
    beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.stubEnv('VH_TEAM_SCOPE_FILE', undefined); });
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
    it('parses the five commands strictly', () => {
        expect(parseIssueArgs(['create', '--title', 'x', '--assign', 'codex', '--dir', '/r', '--label', 'a', '--label', 'b']).multi['--label']).toEqual(['a', 'b']);
        for (const bad of [['nope'], ['show'], ['show', 'zz top'], ['comment', 'VH-1'], ['create'], ['create', '--title', 'x', '--dir', '/r'], ['update', 'VH-1', '--status', 'finished'], ['list', '--title', 'x']]) {
            expect(() => parseIssueArgs(bad)).toThrow();
        }
    });
    it('assign: AGENT runs on this machine, AGENT@ID elsewhere; self/none; unknown agents refused', () => {
        expect(parseAssign('codex', 'local-m', '/repo', { permissionMode: 'yolo' })).toEqual({ kind: 'agent', agent: 'codex', machineId: 'local-m', directory: '/repo', permissionMode: 'yolo' });
        expect(parseAssign('claude@m2', 'local-m')).toEqual({ kind: 'agent', agent: 'claude', machineId: 'm2' });
        expect(parseAssign('self', null)).toEqual({ kind: 'self' });
        expect(() => parseAssign('gemini', 'm')).toThrow(/Unknown agent/);
    });
    it('outside a session: create / update / comment use the human routes', async () => {
        const c = api();
        await run(['create', '--title', 'Ship', '--assign', 'codex', '--dir', '/repo', '--priority', 'high'], c);
        expect(c.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Ship', priority: 'high', assignee: { kind: 'agent', agent: 'codex', machineId: 'local-m', directory: '/repo' }, requestId: expect.any(String) }));
        await run(['update', 'VH-4', '--status', 'done'], c);
        expect(c.update).toHaveBeenCalledWith('i1', { status: 'done' });
        await run(['comment', 'VH-4', 'please retry', '--mention', 'claude'], c);
        expect(c.comment).toHaveBeenCalledWith('i1', expect.objectContaining({ body: 'please retry', mentions: [{ kind: 'agent', agent: 'claude' }] }));
        expect(c.agentUpdate).not.toHaveBeenCalled();
    });
    it('inside a session: update / comment go through the agent routes for the bound issue only; create is refused', async () => {
        const c = api();
        const env = { HAPPY_SESSION_ID: 'sess-1' };
        await run(['update', 'VH-4', '--status', 'in_review', '--comment', 'done, tests pass'], c, env);
        expect(c.agentUpdate).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1', status: 'in_review', comment: 'done, tests pass' }));
        expect(c.update).not.toHaveBeenCalled();
        c.agentUpdate.mockRejectedValueOnce(new IssueRequestError(409, 'issue_status_forbidden', {}));
        await expect(run(['update', 'VH-4', '--status', 'done'], c, env)).rejects.toMatchObject({ code: 'issue_status_forbidden' });
        await expect(run(['update', 'VH-9', '--status', 'in_progress'], c, env)).rejects.toThrow(/^issue_not_bound/);
        await expect(run(['update', 'VH-4', '--title', 'x'], c, env)).rejects.toThrow(/only --status and --comment/);
        await run(['comment', 'VH-4', 'progress'], c, env);
        expect(c.agentComment).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1', body: 'progress' }));
        await expect(run(['create', '--title', 'x'], c, env)).rejects.toThrow(/cannot create/);
        expect(c.create).not.toHaveBeenCalled();
        expect(agentSessionId({ HAPPY_SESSION_ID: '../x' })).toBeNull();
    });
    it('list imports legacy Todos once and defaults to open statuses', async () => {
        const c = api();
        await run(['list'], c);
        await run(['list', '--mine'], c);
        expect(c.importLegacyTodos).toHaveBeenCalledTimes(1);
        expect(c.list).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: 'backlog,todo,in_progress,in_review,blocked' }));
        expect(c.list).toHaveBeenNthCalledWith(2, expect.objectContaining({ assigneeKind: 'self' }));
    });
    it('scoped Teams sessions cannot touch account Issues', async () => {
        vi.stubEnv('VH_TEAM_SCOPE_FILE', '/scope');
        await expect(run(['list'], api())).rejects.toThrow(/Scoped Teams/);
    });
});

describe('B-874 wiring (source assertions)', () => {
    const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
    it('the daemon runs the issue worker and feeds it turn / exit events', () => {
        const run = src('daemon/run.ts');
        expect(run).toMatch(/issueWorker = createIssueWorker\(\{/);
        expect(run).toMatch(/joinProject\(projectsClient, sessionId, \{ kind: 'explicit', projectId \}, \{ via: 'issue' \}\)/);
        expect(run).toMatch(/turnActivity\.onEvent\(\(sessionId, event\) => issueWorker\?\.report\(sessionId, event === 'turn_started' \? 'running' : 'idle'\)\)/);
        expect(run).toMatch(/issueWorker\.report\(session\.happySessionId, daemonHibernation\.pendingExit\(session\.happySessionId\) \? 'idle' : issueExitEvent\(exit\)\)/);
        expect(run).toMatch(/onChildExited\(happyProcess\.pid, \{ code, signal \}\)/);
        expect(run).toMatch(/issueWorker\?\.stop\(\)/);
    });
    it('issue_* tools are registered in-process and forwarded by the Codex bridge; three runners advertise issue-v1 + metadata.issue', () => {
        expect(src('claude/utils/startHappyServer.ts')).toMatch(/registerIssueTools\(mcp, createIssueToolExecutor\(\(\) => client\.sessionId\)\)/);
        expect(src('claude/utils/startHappyServer.ts')).toMatch(/\.\.\.ISSUE_TOOL_NAMES,/);
        expect(src('codex/happyMcpStdioBridge.ts')).toMatch(/registerIssueTools\(server, async/);
        for (const file of ['claude/runClaude.ts', 'codex/runCodex.ts', 'agent/acp/runAcp.ts']) {
            expect(src(file)).toMatch(/metadata\.capabilities = \[\.\.\.\(metadata\.capabilities \?\? \[\]\), ISSUE_SESSION_CAPABILITY\];/);
            expect(src(file)).toMatch(/\.\.\.issueSessionMetadata\(\),/);
        }
        expect(src('projects/injector.ts')).toMatch(/return await withIssue\(out\)/);
    });
});
