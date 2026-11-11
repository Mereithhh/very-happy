import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatchGate } from '@/assistant/gates/dispatchGate';
import { compileOutboundDenylist, outboundPreToolUseHook } from '@/assistant/gates/outboundDenylist';
import type { MainAgentRuntime } from '@/assistant/gates/setup';
import { PRESET_POLICIES } from '@slopus/happy-wire';
import { mainAgentMustAskHook } from '@/assistant/gates/setup';
import { MAIN_AGENT_TOOL_POLICY, mainAgentToolClass } from '@/assistant/mainAgentToolPolicy';

/** B-916c: the main agent surface exists only with the gate runtime (Claude path). */
function testMainAgent(): MainAgentRuntime {
    const denylist = compileOutboundDenylist();
    return { config: { skillRoots: [], deniedTools: [], dropped: 0 }, safety: { safety: { v: 1, preset: 'strict', overrides: {}, allowedTools: [] }, policy: { ...PRESET_POLICIES.strict }, allowedTools: [], failedClosed: false }, denylist, preToolUse: outboundPreToolUseHook(denylist), extraDirectories: [],
        gate: createDispatchGate({ pendingDir: join(mkdtempSync(join(tmpdir(), 'vh-surface-')), 'pending'), board: null, classify: null, approvalLink: (id) => id }) };
}

/** B-924b: the gate exactly as prepareMainAgent builds it (mainAgentMustAskHook, Bash on) on a recording board. */
function gatedMainAgent(cards: Array<{ title: string; bodyMd: string }>): MainAgentRuntime {
    const base = testMainAgent();
    const board = {
        postDecision: async (card: any) => { cards.push(card); return { id: `card-${cards.length}`, key: card.key, state: 'open', ownerChoice: null, resolvedBy: null, title: card.title, bodyMd: card.bodyMd, options: [] } as any; },
        findByKey: async () => null, findById: async () => null,
    };
    return { ...base, gate: createDispatchGate({ pendingDir: join(mkdtempSync(join(tmpdir(), 'vh-surface-gated-')), 'pending'), board, classify: null, approvalLink: (id) => id, mustAsk: mainAgentMustAskHook(() => true) }) };
}

/**
 * B-916b through the real MCP transport (startHappyServer): the main agent
 * (assistant variant, no team scope) gets its own tools plus owner_board_*,
 * and EVERY tool it can call answers within its ceiling — writes ≤ 400,
 * lists ≤ 4,000, bodies ≤ 8,000 — even when the backend answers megabytes.
 * A normal session's answers stay uncapped (B-911 owns the server side).
 */

const HUGE = 'x'.repeat(60_000);
/** Per-item filler for long lists (hundreds of items × MID is still megabytes of JSON). */
const MID = 'm'.repeat(1_500);
const many = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));
const state = vi.hoisted(() => ({ spawnCalls: [] as any[], order: [] as string[], boardPosts: [] as any[], lifecycle: [] as string[], backend: [] as string[] }));

vi.mock('@/attention/client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/attention/client')>();
    const item = (i: number) => ({ id: `item-${i}`, sessionId: 's', teamId: null, projectId: null, source: 'lead', kind: 'decision', key: `k${i}`, title: `Decide ${i} ${'t'.repeat(150)}`, bodyMd: MID, options: null, links: null, anchor: null, firstReply: null, replyToId: null, inferred: false, needsOwner: true, state: 'open', ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0, createdAt: 0, updatedAt: 0, resolvedAt: null, pushedAt: null, version: 0 });
    const client = {
        isDisabled: () => false, probe: async () => true,
        post: async (body: any) => { state.boardPosts.push(body); return { item: item(0), created: true }; },
        patch: async () => ({ item: item(1) }),
        resolve: async () => ({ item: item(2) }),
        list: async () => ({ items: many(200, item) }),
    };
    return { ...actual, sharedAttentionClient: () => client };
});
vi.mock('@/attention/leadBoard', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/attention/leadBoard')>();
    return { ...actual, resolveTeamLead: async () => false };
});
vi.mock('@/automations/client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/automations/client')>();
    const automation = (i: number) => ({ id: `auto-${i}`, name: `job-${i}`, description: MID, machineId: 'm1', status: 'active', trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Singapore' }, action: { kind: 'spawn', prompt: MID }, concurrency: 'skip', maxRuntimeMs: 1, nextRunAt: 1_800_000_000_000, version: 1, lastRunAt: null, lastRunStatus: null, createdAt: 0, updatedAt: 0 });
    const run = (i: number) => ({ id: `run-${i}`, automationId: 'auto-1', automationName: 'job-1', machineId: 'm1', source: 'schedule', status: 'done', summary: MID, error: null, payload: MID, sessionId: 's', needsAttention: false, createdAt: 0, startedAt: 0, finishedAt: 0 });
    const client = {
        list: async () => many(300, automation), get: async () => ({ ...automation(1), description: HUGE }), getByName: async () => ({ ...automation(1), description: HUGE }),
        create: async () => { state.backend.push('automation.create'); return automation(2) }, update: async () => { state.backend.push('automation.update'); return automation(3) },
        pause: async () => { state.backend.push('automation.pause'); return automation(4) }, resume: async () => { state.backend.push('automation.resume'); return automation(5) },
        remove: async () => { state.backend.push('automation.delete') }, run: async () => { state.backend.push('automation.run'); return run(1) },
        fire: async () => { state.backend.push('automation.fire'); return { run: run(2), deduped: false } },
        runs: async () => many(300, run), report: async () => run(3), ack: async () => run(4),
        createWithPrecheck: async () => { state.backend.push('automation.create'); return automation(2) },
    };
    return { ...actual, authenticatedAutomationsClient: async () => ({ client, machineId: 'm1' }) };
});
vi.mock('@/automations/precheckCompat', () => ({
    createAutomationChecked: async (client: any) => client.create(),
    updateAutomationChecked: async (client: any) => client.update(),
}));
vi.mock('@/teams/client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/teams/client')>();
    const task = (i: number) => ({ id: `task-${i}`, parentTaskId: null, status: 'running', goal: MID, acceptance: [MID], assigneeBotId: 'b', ownerBotId: 'o', currentAttemptId: `att-${i}`, goalVersion: 1, cleanup: 'none', attempts: [{ id: `att-${i}`, botId: 'b', generation: 1, goalVersion: 1, status: 'running', result: MID }] });
    const team = { id: 'team-1', name: 'Dev', version: 1, bots: many(30, i => ({ id: `bot-${i}`, name: `B${i}`, root: i === 0, activity: 'active', lastEvent: 'idle' })), tasks: many(60, task), messages: many(100, i => ({ id: `m${i}`, taskId: 'task-1', senderBotId: 'bot-0', recipientBotId: 'bot-1', body: MID, deliveredAt: 1, createdAt: 1 })), operations: [], capacity: { metrics: {} } };
    return { ...actual, createTeamsClient: () => ({ initialize: async () => ({ team, botId: 'bot-0' }), inspect: async () => ({ team, botId: 'bot-0' }), action: async () => ({ team, taskId: 'task-1' }) }) };
});
vi.mock('@/assistant/mainAgentDeps', async () => {
    const { mainAgentTurnOrigin } = await import('@/assistant/turnOrigin');
    const issue = (i: number) => ({ id: `iss-${i}`, key: `VH-${i}`, number: i, title: `Issue ${i} ${'t'.repeat(300)}`, description: MID, status: 'todo', priority: 'none', labels: [], assignee: { kind: 'none' }, version: 1 });
    const entry = (i: number) => ({ id: `e${i}`, seq: i, projectId: 'p1', kind: i % 3 ? 'finding' : 'decision', title: `Entry ${i} ${'t'.repeat(300)}`, body: MID, authorSessionId: null, authorUser: true, supersedes: null, supersededBy: null, revokedAt: null, createdAt: i });
    return {
        createMainAgentDeps: (sessionId: () => string) => ({
            listTeams: async () => many(80, i => ({ id: `team-${i}`, name: `Team ${i} ${'n'.repeat(200)}`, projectId: 'p1', bots: [{ id: 'lead', name: 'Lead', root: true, sessionId: `lead-session-${i}`, activity: 'active' }], tasks: [] })),
            deliver: async () => ({ delivered: true }),
            issues: { list: async () => ({ issues: many(50, issue), nextCursor: 'c' }), get: async () => ({ issue: issue(1) }), create: async () => ({ issue: issue(2), runs: [{ seq: 1, agent: 'codex' }] }), update: async () => ({ issue: issue(3), runs: [] }), comment: async () => ({ issue: issue(4) }) },
            projects: {
                list: async () => ({ projects: many(100, i => ({ id: `p${i}`, name: `Project ${i}`, goal: MID, teamIds: [], archivedAt: null })) }),
                get: async () => ({ project: { id: 'p1', name: 'VH', goal: HUGE, instructions: HUGE, instructionsVersion: 1 }, members: [], presence: [], log: many(200, entry) }),
                note: async () => ({ entry: { seq: 9, supersedes: null } }),
            },
            todo: async (command: any) => command.action === 'list'
                ? { records: many(300, i => ({ id: `u${i}`, key: `VH-${i}`, title: `Todo ${i} ${'t'.repeat(300)}`, status: 'open', version: 1 })) }
                : { id: 'u1', key: 'VH-1', title: 'T'.repeat(500), status: command.action === 'complete' ? 'done' : 'open', version: 2 },
            machineId: async () => 'm1',
            sessionId,
            turnOrigin: mainAgentTurnOrigin,
            // B-924: boards_read / sessions_search / wrapup_* over huge backends.
            ops: {
                board: {
                    list: async () => ({ items: many(200, i => ({ id: `item-${i}`, sessionId: 's', teamId: `team-${i % 80}`, projectId: null, source: 'lead', kind: 'decision', key: `k${i}`, title: `Decide ${i} ${'t'.repeat(150)}`, bodyMd: MID, options: null, links: null, anchor: null, firstReply: null, replyToId: null, inferred: false, needsOwner: true, state: 'open', ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0, createdAt: 0, updatedAt: 0, resolvedAt: null, pushedAt: null, version: 0 })) }),
                    post: async () => ({ item: { id: 'card-9' }, created: true }),
                    resolve: async () => ({ item: { id: 'x' } }),
                },
                sessions: async () => many(300, i => ({ id: `sess-${i}`, title: `Session ${i} ${'t'.repeat(300)}`, cwd: `/repo/${'d'.repeat(100)}`, flavor: 'claude', archived: false, active: true, attention: false, readable: true, updatedAt: i })),
                projectSessionIds: async () => many(300, i => `sess-${i}`),
            },
        }),
    };
});
// B-919: the backends startHappyServer installs (their own logic: mainAgentLifecycle.test.ts).
vi.mock('@/assistant/mainAgentLifecycle', () => ({
    createLiveMainAgentLifecycle: (selfId: () => string) => ({
        wrapup: async ({ sessionId }: any) => { state.lifecycle.push(`wrapup:${sessionId}:${selfId()}`); return { ok: true, sessionId, state: 'queued' }; },
        handoff: async ({ from, to }: any) => { state.lifecycle.push(`handoff:${from}->${to}`); return { ok: true, from, to: to === 'new' ? 'fresh' : to, state: 'queued' }; },
        restart: async ({ sessionId, when }: any) => { state.lifecycle.push(`restart:${sessionId}:${when}`); return { ok: true, sessionId, scheduled: when }; },
    }),
}));
vi.mock('@/sessions/sessionOps', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sessions/sessionOps')>();
    const summary = (i: number) => ({ id: `sess-${i}`, live: true, title: `Session ${i} ${'t'.repeat(300)}`, cwd: `/repo/${'d'.repeat(100)}`, flavor: 'claude', url: `https://example.test/s/${i}` });
    return {
        ...actual,
        listSessions: async () => many(150, summary),
        readSessionTranscript: async () => ({ summary: summary(1), messageCount: 20, transcript: HUGE }),
        archiveSession: async (id: string) => { state.backend.push(`archive:${id}`); },
        stopSession: async () => true,
    };
});
vi.mock('@/assistant/bootstrap', async () => {
    const { mkdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const home = mkdtempSync(join(tmpdir(), 'b916b-assistant-'));
    writeFileSync(join(home, 'personal.md'), '# memory\n');
    mkdirSync(join(home, 'memory', 'journal'), { recursive: true });
    return { bootstrapAssistantHome: async () => ({ home, created: [] }), assistantPersonalMemoryPath: () => join(home, 'personal.md'), assistantHome: () => home };
});
vi.mock('@/assistant/terminals', () => ({
    listVhTerminals: () => ({ ok: true, terminals: many(200, i => ({ id: `t${i}`, title: `Terminal ${i} ${'t'.repeat(200)}`, cwd: '/repo' })) }),
    readVhTerminal: () => ({ ok: true, text: HUGE }),
    sendToVhTerminal: () => ({ ok: true }),
}));
vi.mock('@/daemon/controlClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
    return { ...actual, spawnDaemonSession: async (directory: string, _sid: unknown, opts: any) => { state.spawnCalls.push({ directory, opts }); state.order.push('spawn'); return { success: true, sessionId: 'new-session' }; } };
});
vi.mock('@/commands/sessionMessage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/commands/sessionMessage')>();
    return { ...actual, waitForSessionKey: async () => ({ encryptionKey: 'k', metadata: { summary: { text: 'T' } } }), sendUserMessage: async () => { state.order.push('prompt'); } };
});
// B-924b: handoff_send's delivery (B-915 tracker → sendPeerMessage), recorded.
vi.mock('@/sessions/peerTools', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sessions/peerTools')>();
    return { ...actual, sendPeerMessage: async (_ctx: unknown, args: any) => { state.backend.push(`peer:${args.purpose}:${args.to}`); return { delivered: true, status: 'live', sessionId: args.to }; } };
});
vi.mock('@/commands/sessionDelivery', () => ({ deliverToSession: async (...args: any[]) => { state.backend.push(`deliver:${JSON.stringify(args).slice(0, 200)}`); return { delivered: true, status: 'live' }; } }));
vi.mock('@/projects/attribution', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/projects/attribution')>();
    return { ...actual, joinProject: async (_c: unknown, _s: string, choice: any) => { state.order.push(`join:${choice.projectId}`); return { joined: true, projectId: choice.projectId, via: 'explicit' }; } };
});
vi.mock('@/projects/client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/projects/client')>();
    const client = { isDisabled: () => false, defaults: async () => ({}), membership: async () => ({ projectId: null, via: null }), context: async () => { throw new Error('no project'); }, digest: async () => ({}) };
    return { ...actual, sharedProjectsClient: () => client };
});
vi.mock('@/persistence', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/persistence')>();
    return { ...actual, readPersistedSessions: () => ({ 'sess-1': { metadata: { summary: { text: 'x' } } } }), readSettings: async () => ({ machineId: 'm1' }) };
});

const { startHappyServer } = await import('@/claude/utils/startHappyServer');
const { RECEIPT_MAX_CHARS, LIST_MAX_CHARS, BODY_MAX_CHARS, capClassFor } = await import('./toolCaps');
const { MAIN_AGENT_TOOL_NAMES } = await import('./mainAgentTools');
const { ASSISTANT_TOOL_NAMES } = await import('./assistantTools');

function fakeSession(id: string) {
    const emitter = new EventEmitter() as EventEmitter & Record<string, any>;
    let metadata: Record<string, any> = { machineId: 'm1' };
    emitter.sessionId = id;
    emitter.getMetadata = () => metadata;
    emitter.updateMetadata = (fn: (m: Record<string, any>) => Record<string, any>) => { metadata = fn(metadata); };
    emitter.rpcHandlerManager = { registerHandler: () => {}, unregisterHandler: () => {} };
    return emitter;
}

/** Arguments that take each tool down its success path (the backends above answer huge). */
const ARGS: Record<string, Record<string, unknown>> = {
    dispatch_approved: { approvalId: '00000000-0000-0000-0000-000000000000' },
    session_read: { sessionId: 'sess-1' }, session_send: { sessionId: 'sess-1', text: 'go' },
    session_spawn: { directory: '/tmp/b916b-surface', prompt: 'do Y', title: 'Do Y in X', agent: 'codex', projectId: 'p1' },
    session_kill: { sessionId: 'sess-1' }, session_archive: { sessionId: 'sess-1' },
    terminal_read: { terminalId: 't1' }, terminal_send: { terminalId: 't1', text: 'ls' },
    automation_get: { name: 'job-1' }, automation_create: { name: 'job-2', trigger: { kind: 'manual' }, action: { kind: 'spawn', agent: 'claude', directory: '/tmp', prompt: 'p' } },
    change_title: { title: 'T' }, copy_to_clipboard: { text: 't' }, open_preview: { path: '/tmp/b916b-none' }, request_human: { reason: 'r' }, report_progress: { progress: 'p' },
    memory_update: { section: 'Owner', content: 'c' }, journal_append: { content: 'c' },
    automation_update: { name: 'job-1', version: 1, newName: 'job-9' }, automation_pause: { name: 'job-1' }, automation_resume: { name: 'job-1' },
    automation_delete: { name: 'job-1' }, automation_run: { name: 'job-1' }, automation_fire: { name: 'job-1' }, automation_ack: { runId: 'run-1' },
    automation_report: { runId: 'run-1', status: 'done', summary: 's' },
    team_create: { name: 'n', requestId: 'r' }, team_join: { teamId: 'team-1', name: 'n', requestId: 'r' },
    team_delegate: { requestId: 'r', goal: 'g', acceptance: ['a'] }, team_message: { requestId: 'r', taskId: 'task-1', body: 'b' },
    team_submit: { requestId: 'r', taskId: 'task-1', attemptId: 'att-1', goalVersion: 1, result: 'done' },
    team_accept: { requestId: 'r', taskId: 'task-1', attemptId: 'att-1', goalVersion: 1 },
    team_return: { requestId: 'r', taskId: 'task-1', attemptId: 'att-1', goalVersion: 1, reason: 'more' },
    team_cancel: { requestId: 'r', taskId: 'task-1', attemptId: 'att-1', goalVersion: 1, reason: 'stop' },
    team_handoff: { requestId: 'r', taskId: 'task-1', attemptId: 'att-1', goalVersion: 1, assigneeBotId: 'bot-2' },
    team_schedule_create: { requestId: 'r', name: 'n', botId: 'bot-0', body: 'b', runAt: 1 },
    team_schedule_pause: { requestId: 'r', scheduleId: 's', version: 1 }, team_schedule_resume: { requestId: 'r', scheduleId: 's', version: 1 },
    team_schedule_cancel: { requestId: 'r', scheduleId: 's', version: 1 },
    session_message: { to: 'sess-1', body: 'hi' },
    lead_delegate: { teamId: 'team-1', goal: 'Ship it', acceptance: ['green'] }, lead_message: { teamId: 'team-1', body: 'hi' },
    issue_get: { issue: 'VH-1' }, issue_create: { title: 'New' }, issue_assign: { key: 'VH-1', assignee: { agent: 'codex' } }, issue_comment: { issue: 'VH-1', body: 'hi' },
    todo_add: { title: 'Call' }, todo_complete: { id: 'VH-1', version: 1 },
    wrapup_suggest: { sessions: [{ sessionId: 'sess-1', reason: 'idle 2 days' }] }, wrapup_selected: { boardItemId: 'item-0' },
    project_context: { projectId: 'p1', full: true }, project_note: { projectId: 'p1', kind: 'finding', title: 't' }, sessions_list: { limit: 50 },
    owner_board_post: { kind: 'report', title: 'Merged', request_id: 'r1' }, owner_board_update: { id: 'item-1', title: 'x', request_id: 'r2' },
    owner_board_resolve: { id: 'item-1', outcome: 'done', request_id: 'r3' }, owner_board_list: { state: 'all' },
    session_wrapup: { sessionId: 'sess-1' }, session_handoff: { from: 'sess-1', to: 'new' }, session_restart: { sessionId: 'sess-1', when: 'now' },
    // B-915: the session-scoped wrapup_report / handoff_send also sit on the main agent's surface (capped).
    wrapup_report: { summary: 'done', can_close: true }, handoff_send: { to: 'sess-1', summary: 'next steps' },
};
const CAP = { receipt: RECEIPT_MAX_CHARS, list: LIST_MAX_CHARS, body: BODY_MAX_CHARS } as const;
const textOf = (r: any) => (r.content as Array<{ text: string }>).map(c => c.text).join('\n');

describe('main agent tool surface (B-916b)', { timeout: 30_000 }, () => {
    let happy: Awaited<ReturnType<typeof startHappyServer>> | undefined;
    let mcp: Client | undefined;
    afterEach(async () => {
        await mcp?.close(); mcp = undefined;
        happy?.stop(); happy = undefined;
        state.spawnCalls = []; state.order = []; state.boardPosts = []; state.lifecycle = []; state.backend = [];
        delete process.env.VH_TEAM_SCOPE_FILE;
    });

    let session: ReturnType<typeof fakeSession> | undefined;
    /** B-924: a turn started by one prompt routed with this sentFrom (web = the owner typing). */
    function turn(localId: string, sentFrom: string) {
        session!.emit('user-message-routed', { localId, message: { content: { text: 'x' }, meta: { sentFrom } } });
        session!.emit('turn-started', [localId]);
    }
    async function connect(options: { assistant?: boolean; mainAgent?: MainAgentRuntime }, id = 'main-agent') {
        session = fakeSession(id);
        happy = await startHappyServer(session as any, options);
        mcp = new Client({ name: 'b916b-probe', version: '1' });
        await mcp.connect(new StreamableHTTPClientTransport(new URL(happy.url)));
        return (await mcp.listTools()).tools;
    }

    it('registers the main agent tools and owner_board_* only on the main agent', async () => {
        const tools = await connect({ assistant: true, mainAgent: testMainAgent() });
        const names = tools.map(t => t.name);
        expect(names).toEqual(expect.arrayContaining([...ASSISTANT_TOOL_NAMES, ...MAIN_AGENT_TOOL_NAMES, 'owner_board_post', 'owner_board_list']));
        expect(new Set(names).size).toBe(names.length);
        expect(happy!.toolNames).toEqual(expect.arrayContaining([...MAIN_AGENT_TOOL_NAMES]));
        // Pageable tools carry the cursor; receipts do not.
        const schema = (name: string) => Object.keys((tools.find(t => t.name === name)!.inputSchema as any).properties ?? {});
        expect(schema('automation_list')).toContain('cursor');
        expect(schema('team_inspect')).toContain('cursor');
        expect(schema('session_spawn')).toEqual(expect.arrayContaining(['title', 'agent', 'projectId']));
        expect(schema('session_spawn')).not.toContain('cursor');
        await mcp!.close(); happy!.stop(); mcp = undefined; happy = undefined;

        const normal = (await connect({})).map(t => t.name);
        expect(normal).not.toContain('lead_delegate');
        expect(normal).not.toContain('owner_board_post');
        expect(normal).toContain('issue_list');
    });

    it('B-919: session_wrapup / session_handoff registered once each and wired to the installed backends; a normal session keeps the B-915 tools', async () => {
        const tools = await connect({ assistant: true, mainAgent: testMainAgent() });
        const names = tools.map(t => t.name);
        for (const name of ['session_wrapup', 'session_handoff', 'session_restart', 'wrapup_report', 'handoff_send']) expect(names.filter(n => n === name), name).toHaveLength(1);
        // The main agent's own contract (one sessionId), not the B-915 batch shape.
        expect(Object.keys((tools.find(t => t.name === 'session_wrapup')!.inputSchema as any).properties)).toEqual(['sessionId', 'requestId']);
        turn('u-owner-1', 'web');
        const wrap = await mcp!.callTool({ name: 'session_wrapup', arguments: { sessionId: 'sess-9' } });
        expect(wrap.isError).toBe(false);
        expect(JSON.parse(textOf(wrap))).toEqual({ ok: true, sessionId: 'sess-9', state: 'queued' });
        expect(JSON.parse(textOf(await mcp!.callTool({ name: 'session_handoff', arguments: { from: 'sess-9' } })))).toEqual({ ok: true, from: 'sess-9', to: 'fresh', state: 'queued' });
        expect(state.lifecycle).toEqual(['wrapup:sess-9:main-agent', 'handoff:sess-9->new']);
        await mcp!.close(); happy!.stop(); mcp = undefined; happy = undefined;

        const normal = await connect({}, 'normal-session');
        const normalNames = normal.map(t => t.name);
        for (const name of ['session_wrapup', 'session_handoff', 'wrapup_report', 'handoff_send']) expect(normalNames.filter(n => n === name), name).toHaveLength(1);
        expect(normalNames).not.toContain('session_restart');
        expect(Object.keys((normal.find(t => t.name === 'session_wrapup')!.inputSchema as any).properties)).toEqual(expect.arrayContaining(['session_ids', 'session_id']));
    });

    it('B-924 (QA P1-2/3): over the real transport, a turn the owner did not type wraps up, hands off, archives, kills and restarts nothing', async () => {
        await connect({ assistant: true, mainAgent: testMainAgent() });
        for (const [localId, sentFrom] of [['3f1c-cli', 'cli'], ['automation-run-1', 'automation'], ['session-message-1', 'web']] as const) {
            turn(localId, sentFrom);
            for (const [name, args] of [['session_wrapup', { sessionId: 'sess-1' }], ['session_handoff', { from: 'sess-1', to: 'sess-2' }], ['session_archive', { sessionId: 'sess-1' }], ['session_kill', { sessionId: 'sess-1' }], ['session_restart', { sessionId: 'sess-1', when: 'now' }]] as const) {
                const r = await mcp!.callTool({ name, arguments: args });
                expect(r.isError, `${name} in a ${sentFrom} turn`).toBe(true);
                expect(JSON.parse(textOf(r))).toMatchObject({ ok: false, error: 'owner_request_required' });
            }
        }
        expect(state.lifecycle).toEqual([]);
        turn('u-owner-2', 'web');
        expect((await mcp!.callTool({ name: 'session_wrapup', arguments: { sessionId: 'sess-1' } })).isError).toBe(false);
        expect(state.lifecycle).toEqual(['wrapup:sess-1:main-agent']);
    });

    // ── B-924b: the whole surface, classified (mainAgentToolPolicy.ts) ──────────────────────────────
    it('B-924b inventory: every tool the real server registers on the main agent is classified, and the table names nothing it does not register', async () => {
        const names = (await connect({ assistant: true, mainAgent: gatedMainAgent([]) })).map(t => t.name);
        const unclassified = names.filter(n => !mainAgentToolClass(n));
        expect(unclassified, 'add these to MAIN_AGENT_TOOL_POLICY (owner_only | ask | allow) and to the spec table').toEqual([]);
        expect(Object.keys(MAIN_AGENT_TOOL_POLICY).filter(n => !names.includes(n)), 'stale entries').toEqual([]);
        expect(names.length).toBe(Object.keys(MAIN_AGENT_TOOL_POLICY).length);
    });

    it('B-924b: in a turn the owner did not type, every owner_only tool refuses and every ask tool parks a card; nothing reaches a backend', async () => {
        const cards: Array<{ title: string; bodyMd: string }> = [];
        const tools = await connect({ assistant: true, mainAgent: gatedMainAgent(cards) });
        const hasRisk = (name: string) => Object.keys((tools.find(t => t.name === name)!.inputSchema as any).properties ?? {}).includes('risk');
        let n = 0;
        for (const [localId, sentFrom] of [['3f1c-cli', 'cli'], ['automation-run-7', 'automation'], ['session-message-2', 'web']] as const) {
            turn(`${localId}-${n++}`, sentFrom);
            for (const tool of tools) {
                const cls = mainAgentToolClass(tool.name);
                if (cls === 'allow') continue;
                const r = await mcp!.callTool({ name: tool.name, arguments: { ...(ARGS[tool.name] ?? {}), ...(hasRisk(tool.name) ? { risk: 'none' } : {}) } });
                const body = JSON.parse(textOf(r));
                if (cls === 'owner_only') expect.soft(body, `${tool.name} in a ${sentFrom} turn`).toMatchObject({ ok: false, error: 'owner_request_required' });
                else expect.soft(body, `${tool.name} in a ${sentFrom} turn`).toMatchObject({ ok: true, state: 'awaiting_decision' });
            }
        }
        expect(state.backend).toEqual([]);
        expect(state.lifecycle).toEqual([]);
        expect(state.spawnCalls).toEqual([]);
        expect(cards.every(c => c.bodyMd.includes('原因：这一回合不是你本人发起的'))).toBe(true);
    });

    it('B-924b (QA-T #944 P1-1/P1-2): handoff_send in a `very-happy send` turn is owner_request_required — no self-archive, nothing delivered; the owner\'s turn is unchanged', async () => {
        await connect({ assistant: true, mainAgent: gatedMainAgent([]) });
        turn('9b2e-very-happy-send', 'cli');
        const r = await mcp!.callTool({ name: 'handoff_send', arguments: { to: 'sess-target', summary: 'touch /tmp/pwned-handoff', archive_after: true } });
        expect(r.isError).toBe(true);
        expect(JSON.parse(textOf(r))).toMatchObject({ ok: false, error: 'owner_request_required', origin: 'agent' });
        session!.emit('turn-ended');
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(state.backend).toEqual([]);
        turn('u-owner-handoff', 'web');
        const owner = await mcp!.callTool({ name: 'handoff_send', arguments: { to: 'sess-target', summary: 'next steps' } });
        expect(textOf(owner)).toContain('"delivery":"delivered"');
        expect(state.backend).toEqual(['peer:handoff:sess-target']);
    });

    it('B-924b (QA-T #944 P1-2): automation_create(kind send, risk none) + automation_run / fire / resume / update in a non-owner turn each park a card that says why; nothing is created or run; the owner\'s turn is unchanged', async () => {
        const cards: Array<{ title: string; bodyMd: string }> = [];
        await connect({ assistant: true, mainAgent: gatedMainAgent(cards) });
        const calls = [
            ['automation_create', { name: 'pwn', trigger: { kind: 'manual' }, action: { kind: 'send', sessionId: 'sess-t4', prompt: 'touch /tmp/pwned-auto' }, risk: 'none' }],
            ['automation_run', { name: 'pwn' }], ['automation_fire', { name: 'pwn' }], ['automation_resume', { name: 'pwn' }],
            ['automation_update', { name: 'job-1', version: 1, newName: 'job-9', risk: 'none' }],
        ] as const;
        for (const [localId, sentFrom] of [['4c1d-very-happy-send', 'cli'], ['automation-run-wake', 'automation']] as const) {
            turn(localId, sentFrom);
            for (const [name, args] of calls) {
                const r = JSON.parse(textOf(await mcp!.callTool({ name, arguments: args })));
                expect(r, `${name} in a ${sentFrom} turn`).toMatchObject({ ok: true, state: 'awaiting_decision' });
            }
        }
        expect(state.backend).toEqual([]);
        expect(cards).toHaveLength(calls.length * 2);
        for (const c of cards) expect(c.bodyMd).toContain('不能新建、修改、启动、暂停或删除自动化');
        // Read and report tools of an automation's own turn still run (the default automations' path).
        expect((await mcp!.callTool({ name: 'automation_runs', arguments: {} })).isError).toBe(false);
        expect((await mcp!.callTool({ name: 'automation_report', arguments: ARGS.automation_report })).isError).toBe(false);
        turn('u-owner-auto', 'web');
        for (const [name, args] of calls) {
            const r = await mcp!.callTool({ name, arguments: args });
            expect(textOf(r), name).not.toContain('awaiting_decision');
        }
        expect(state.backend).toEqual(['automation.create', 'automation.run', 'automation.fire', 'automation.resume', 'automation.update']);
        expect(cards).toHaveLength(calls.length * 2);
    });

    it('QA77 #6: an assistant without the gate runtime (pi / ACP) gets only the legacy B-051 tools', async () => {
        const names = (await connect({ assistant: true })).map(t => t.name);
        expect(names).toContain('sessions_list');
        for (const t of ['lead_delegate', 'teams_list', 'issue_create', 'todo_add', 'project_list', 'dispatch_approved', 'owner_board_post']) expect(names).not.toContain(t);
    });

    it('a team-scoped assistant is not the main agent', async () => {
        process.env.VH_TEAM_SCOPE_FILE = '/nonexistent/scope.json';
        const names = (await connect({ assistant: true, mainAgent: testMainAgent() })).map(t => t.name);
        expect(names).not.toContain('lead_delegate');
        expect(names).not.toContain('sessions_list');
    });

    it('every tool on the main agent answers within its ceiling', async () => {
        const tools = await connect({ assistant: true, mainAgent: testMainAgent() });
        const sizes: Record<string, number> = {};
        const texts: Record<string, string> = {};
        for (const tool of tools) {
            // B-916c: dispatch tools take a required `risk` on the main agent; `none` runs the tool itself.
            const args = { ...(ARGS[tool.name] ?? {}), ...(Object.keys((tool.inputSchema as any)?.properties ?? {}).includes('risk') ? { risk: 'none' } : {}) };
            const result = await mcp!.callTool({ name: tool.name, arguments: args });
            const text = textOf(result);
            const cls = result.isError ? 'receipt' : capClassFor(tool.name, args, (tool.annotations as any)?.readOnlyHint === true);
            sizes[tool.name] = text.length;
            // Valid arguments everywhere: an SDK-side schema refusal never reaches the handler (or the caps).
            expect.soft(text, `${tool.name}: SDK input validation`).not.toContain('Input validation error');
            expect.soft(text.length, `${tool.name} (${cls}${result.isError ? `, error: ${text.slice(0, 120)}` : ''})`).toBeLessThanOrEqual(CAP[cls]);
            texts[tool.name] = text;
        }
        // The huge backends really were reached: lists and bodies fill their page.
        for (const name of ['automation_list', 'automation_runs', 'sessions_list', 'team_inspect', 'owner_board_list', 'issue_list', 'todo_list', 'project_list', 'teams_list', 'terminals_list', 'boards_read', 'sessions_search']) {
            expect.soft(sizes[name], `${name}: ${texts[name]?.slice(0, 200)}`).toBeGreaterThan(LIST_MAX_CHARS / 2);
        }
        for (const name of ['session_read', 'terminal_read', 'automation_get', 'project_context']) expect.soft(sizes[name], name).toBeGreaterThan(BODY_MAX_CHARS / 2);
        expect(Object.keys(sizes).length).toBeGreaterThanOrEqual(ASSISTANT_TOOL_NAMES.length + MAIN_AGENT_TOOL_NAMES.length + 12 + 14 + 4);
    });

    it('the main agent posts to the board as source agent', async () => {
        await connect({ assistant: true, mainAgent: testMainAgent() });
        const r = await mcp!.callTool({ name: 'owner_board_post', arguments: { kind: 'report', title: 'Merged', request_id: 'r1' } });
        expect(r.isError).toBe(false);
        expect(state.boardPosts).toEqual([expect.objectContaining({ sessionId: 'main-agent', source: 'agent', kind: 'report', title: 'Merged' })]);
    });

    it('a truncated list names a cursor that continues it', async () => {
        await connect({ assistant: true, mainAgent: testMainAgent() });
        const first = textOf(await mcp!.callTool({ name: 'automation_list', arguments: {} }));
        const cursor = first.match(/cursor="(\d+)"/)?.[1];
        expect(cursor).toBeDefined();
        const second = textOf(await mcp!.callTool({ name: 'automation_list', arguments: { cursor } }));
        expect(second.startsWith(`[continued from cursor="${cursor}"]`)).toBe(true);
        expect(second.length).toBeLessThanOrEqual(LIST_MAX_CHARS);
        // One line per automation (listViews), not the JSON with its prompts.
        expect(first.split('\n')[1]).toMatch(/^job-0 auto-0 active cron\(0 9 \* \* \* Asia\/Singapore\) next=2027-01-15T08:00Z spawn$/);
    });

    it('session_spawn carries title, agent and project; the project is joined before the first prompt', async () => {
        await connect({ assistant: true, mainAgent: testMainAgent() });
        const result = await mcp!.callTool({ name: 'session_spawn', arguments: { ...ARGS.session_spawn, risk: 'none' } });
        const text = textOf(result);
        expect(result.isError).toBe(false);
        expect(state.spawnCalls).toEqual([{ directory: '/tmp/b916b-surface', opts: { spawnedBy: 'assistant', agent: 'codex', title: 'Do Y in X' } }]);
        expect(state.order).toEqual(['spawn', 'join:p1', 'prompt']);
        expect(text).toContain('title="Do Y in X" project=p1');
        expect(text.length).toBeLessThanOrEqual(RECEIPT_MAX_CHARS);
    });

    it('a normal session keeps its uncapped answers', async () => {
        await connect({}, 'normal-session');
        const full = textOf(await mcp!.callTool({ name: 'team_inspect', arguments: { full: true } }));
        expect(full.length).toBeGreaterThan(BODY_MAX_CHARS);
        const list = textOf(await mcp!.callTool({ name: 'automation_list', arguments: {} }));
        expect(list.length).toBeGreaterThan(LIST_MAX_CHARS);
    });
});
