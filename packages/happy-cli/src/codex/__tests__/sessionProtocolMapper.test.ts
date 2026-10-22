import { describe, expect, it } from 'vitest';
import { createId, isCuid } from '@paralleldrive/cuid2';
import {
    mapCodexMcpMessageToSessionEnvelopes,
    mapCodexProcessorMessageToSessionEnvelopes,
    mapCodexThreadToSessionEnvelopes,
} from '../utils/sessionProtocolMapper';

describe('B-628: Codex child threads as sub-agent cards', () => {
    const child = { subagent: 'thread-child-1', subagent_label: 'Review the test suite' };

    it('files a child thread\'s items under one sub-agent, titled by its spawn prompt', () => {
        const state = { currentTurnId: 'turn-1' };
        const begin = mapCodexMcpMessageToSessionEnvelopes({ type: 'exec_command_begin', call_id: 'call-c1', command: 'pnpm test', ...child }, state);
        expect(begin.envelopes.map((e) => e.ev.t)).toEqual(['start', 'tool-call-start']);
        const sessionSubagent = begin.envelopes[0].subagent!;
        expect(isCuid(sessionSubagent)).toBe(true);
        expect(begin.envelopes[0].ev).toEqual({ t: 'start', description: 'Review the test suite' });
        expect(begin.envelopes[1].subagent).toBe(sessionSubagent);

        const text = mapCodexMcpMessageToSessionEnvelopes({ type: 'agent_message', message: 'done', ...child }, begin);
        expect(text.envelopes.map((e) => e.ev.t)).toEqual(['text']);
        expect(text.envelopes[0].subagent).toBe(sessionSubagent);
        // The parent's own message carries no sub-agent.
        const own = mapCodexMcpMessageToSessionEnvelopes({ type: 'agent_message', message: 'all good' }, text);
        expect(own.envelopes[0].subagent).toBeUndefined();
    });

    it('a child without a name starts a plain card', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes({ type: 'agent_message', message: 'hi', subagent: 'thread-child-2' }, { currentTurnId: 'turn-1' });
        expect(result.envelopes[0].ev).toEqual({ t: 'start' });
    });

    it('the child\'s own turn end stops its card; a later turn of the same child starts it again under the same id', () => {
        const state = { currentTurnId: 'turn-1' };
        const first = mapCodexMcpMessageToSessionEnvelopes({ type: 'agent_message', message: 'one', ...child }, state);
        const sessionSubagent = first.envelopes[0].subagent!;
        const end = mapCodexMcpMessageToSessionEnvelopes({ type: 'subagent_turn_end', status: 'interrupted', ...child }, first);
        expect(end.envelopes).toHaveLength(1);
        expect(end.envelopes[0]).toMatchObject({ subagent: sessionSubagent, turn: 'turn-1', ev: { t: 'stop', status: 'stopped' } });
        expect(end.activeSubagents.has(sessionSubagent)).toBe(false);

        const again = mapCodexMcpMessageToSessionEnvelopes({ type: 'agent_message', message: 'two', ...child }, { ...end, currentTurnId: 'turn-1' });
        expect(again.envelopes.map((e) => e.ev.t)).toEqual(['start', 'text']);
        expect(again.envelopes[0].subagent).toBe(sessionSubagent);
        const endAgain = mapCodexMcpMessageToSessionEnvelopes({ type: 'subagent_turn_end', status: 'failed', ...child }, again);
        expect(endAgain.envelopes[0].ev).toEqual({ t: 'stop', status: 'failed' });

        // The parent's turn end has nothing left to stop for it.
        const parentEnd = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_complete' }, { ...endAgain, currentTurnId: 'turn-1' });
        expect(parentEnd.envelopes.map((e) => e.ev.t)).toEqual(['turn-end']);
    });

    it('a name that arrives after the child\'s first item retitles the card once', () => {
        const state = { currentTurnId: 'turn-1' };
        // The child's command lands before the parent's spawn call completed with its prompt.
        const first = mapCodexMcpMessageToSessionEnvelopes({ type: 'exec_command_begin', call_id: 'c1', command: 'ls', subagent: 'thread-child-1' }, state);
        expect(first.envelopes[0].ev).toEqual({ t: 'start' });
        const sessionSubagent = first.envelopes[0].subagent!;
        const named = mapCodexMcpMessageToSessionEnvelopes({ type: 'exec_command_end', call_id: 'c1', ...child }, first);
        expect(named.envelopes.map((e) => e.ev.t)).toEqual(['start', 'tool-call-end']);
        expect(named.envelopes[0]).toMatchObject({ subagent: sessionSubagent, ev: { t: 'start', description: 'Review the test suite' } });
        // Once is enough: the next labelled item does not repeat it.
        const more = mapCodexMcpMessageToSessionEnvelopes({ type: 'agent_message', message: 'done', ...child }, named);
        expect(more.envelopes.map((e) => e.ev.t)).toEqual(['text']);
    });

    it('the parent\'s turn end stops a child still running, and the next turn knows the child under a new id', () => {
        const state = { currentTurnId: 'turn-1' };
        const running = mapCodexMcpMessageToSessionEnvelopes({ type: 'agent_message', message: 'one', ...child }, state);
        const firstId = running.envelopes[0].subagent!;
        const parentEnd = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_complete' }, running);
        expect(parentEnd.envelopes.map((e) => e.ev.t)).toEqual(['stop', 'turn-end']);
        expect(parentEnd.envelopes[0]).toMatchObject({ subagent: firstId, ev: { t: 'stop' } });
        const nextTurn = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_started' }, parentEnd);
        const again = mapCodexMcpMessageToSessionEnvelopes({ type: 'agent_message', message: 'two', ...child }, nextTurn);
        expect(again.envelopes.map((e) => e.ev.t)).toEqual(['start', 'text']);
        expect(again.envelopes[0].subagent).not.toBe(firstId);
        expect(again.envelopes[0].ev).toEqual({ t: 'start', description: 'Review the test suite' });
    });

    it('a turn end for a child never seen emits nothing', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes({ type: 'subagent_turn_end', status: 'completed', subagent: 'thread-unknown' }, { currentTurnId: 'turn-1' });
        expect(result.envelopes).toEqual([]);
    });

    it('a collab call made by a child nests under the child\'s card', () => {
        const item = { type: 'collabAgentToolCall', id: 'spawn-2', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['thread-grandchild'], agentsStates: {}, prompt: 'Dig deeper' };
        const result = mapCodexMcpMessageToSessionEnvelopes({ type: 'collab_agent_item', item, ...child }, { currentTurnId: 'turn-1' });
        expect(result.envelopes.map((e) => e.ev.t)).toEqual(['start', 'tool-call-start', 'tool-call-end']);
        expect(new Set(result.envelopes.map((e) => e.subagent)).size).toBe(1);
        // The parent's own spawn call stays at the top level, as before.
        const top = mapCodexMcpMessageToSessionEnvelopes({ type: 'collab_agent_item', item }, { currentTurnId: 'turn-1' });
        expect(top.envelopes.map((e) => e.ev.t)).toEqual(['tool-call-start', 'tool-call-end']);
        expect(top.envelopes.some((e) => e.subagent)).toBe(false);
    });

    it('steer_dropped is the runner\'s to handle, not a transcript event', () => {
        expect(mapCodexMcpMessageToSessionEnvelopes({ type: 'steer_dropped', client_ids: ['k'] }, { currentTurnId: 'turn-1' }).envelopes).toEqual([]);
    });
});

describe('mapCodexMcpMessageToSessionEnvelopes', () => {
    it('starts and ends turns for task lifecycle events', () => {
        const started = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_started' }, { currentTurnId: null });

        expect(started.envelopes).toHaveLength(1);
        expect(started.envelopes[0].ev.t).toBe('turn-start');
        expect(started.envelopes[0].turn).toBe(started.currentTurnId);
        expect(started.envelopes[0].turn).not.toBe(started.envelopes[0].id);

        const ended = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_complete' }, { currentTurnId: started.currentTurnId });
        expect(ended.envelopes).toHaveLength(1);
        expect(ended.envelopes[0].ev.t).toBe('turn-end');
        if (ended.envelopes[0].ev.t === 'turn-end') {
            expect(ended.envelopes[0].ev.status).toBe('completed');
        }
        expect(ended.envelopes[0].turn).toBe(started.currentTurnId);
        expect(ended.currentTurnId).toBeNull();
    });

    it('maps abort lifecycle with cancelled turn-end status', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'turn_aborted' },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].ev).toEqual({
            t: 'turn-end',
            status: 'cancelled',
        });
        expect(result.currentTurnId).toBeNull();
    });

    it('maps agent text messages with turn context', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'agent_message', message: 'hello' },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].turn).toBe('turn-1');
        expect(result.envelopes[0].ev).toEqual({ t: 'text', text: 'hello' });
    });

    it('maps parent call linkage to subagent field', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'agent_message', message: 'subagent hello', parent_call_id: 'parent-call-1' },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(2);
        const subagent = result.envelopes[1].subagent;
        expect(typeof subagent).toBe('string');
        expect(isCuid(subagent!)).toBe(true);
        expect(result.envelopes[0]).toMatchObject({
            subagent,
            ev: { t: 'start' },
        });
        expect(subagent).not.toBe('parent-call-1');
    });

    it('emits stop for active subagents before turn-end', () => {
        const subagent = createId();
        const activeSubagents = new Set<string>([subagent]);
        const startedSubagents = new Set<string>([subagent]);
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'task_complete' },
            { currentTurnId: 'turn-1', activeSubagents, startedSubagents }
        );

        expect(result.envelopes).toHaveLength(2);
        expect(result.envelopes[0]).toMatchObject({
            subagent,
            ev: { t: 'stop' },
        });
        expect(result.envelopes[1].ev).toEqual({
            t: 'turn-end',
            status: 'completed',
        });
    });

    it('maps exec command begin to tool-call-start', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'exec_command_begin',
                call_id: 'call-1',
                command: 'ls -la',
                cwd: '/tmp',
            },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(1);
        const envelope = result.envelopes[0];
        expect(envelope.ev.t).toBe('tool-call-start');
        if (envelope.ev.t === 'tool-call-start') {
            expect(envelope.ev.call).toBe('call-1');
            expect(envelope.ev.name).toBe('CodexBash');
            expect(envelope.ev.title).toContain('Run `ls -la`');
            expect(envelope.ev.args).toEqual({ command: 'ls -la', cwd: '/tmp' });
        }
    });

    it('skips token_count messages', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'token_count', total_tokens: 10 },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(0);
        expect(result.currentTurnId).toBe('turn-1');
    });
});

describe('mapCodexProcessorMessageToSessionEnvelopes', () => {
    it('maps reasoning tool lifecycle to start/text/end session events', () => {
        const startEvents = mapCodexProcessorMessageToSessionEnvelopes({
            type: 'tool-call',
            callId: 'reasoning-1',
            name: 'CodexReasoning',
            input: { title: 'Plan changes' },
            id: 'legacy-id-1',
        }, { currentTurnId: 'turn-1' });

        expect(startEvents).toHaveLength(1);
        expect(startEvents[0].ev.t).toBe('tool-call-start');

        const endEvents = mapCodexProcessorMessageToSessionEnvelopes({
            type: 'tool-call-result',
            callId: 'reasoning-1',
            output: { content: 'Step 1, Step 2', status: 'completed' },
            id: 'legacy-id-2',
        }, { currentTurnId: 'turn-1' });

        expect(endEvents).toHaveLength(2);
        expect(endEvents[0].ev.t).toBe('text');
        if (endEvents[0].ev.t === 'text') {
            expect(endEvents[0].ev.thinking).toBe(true);
        }
        expect(endEvents[1].ev).toEqual({ t: 'tool-call-end', call: 'reasoning-1' });
    });

    it('maps reasoning text to thinking text event', () => {
        const events = mapCodexProcessorMessageToSessionEnvelopes({
            type: 'reasoning',
            message: 'Working through options',
            id: 'legacy-id-3',
        }, { currentTurnId: 'turn-1' });

        expect(events).toHaveLength(1);
        expect(events[0].ev).toEqual({
            t: 'text',
            text: 'Working through options',
            thinking: true,
        });
    });
});

describe('mapCodexThreadToSessionEnvelopes', () => {
    it('backfills Codex thread turns as session envelopes with codex item ids', () => {
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-1',
                startedAt: 100,
                completedAt: 101,
                status: 'completed',
                items: [
                    { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hello codex' }] },
                    { id: 'agent-1', type: 'agentMessage', text: 'hello human' },
                ],
            }],
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'text',
            'text',
            'turn-end',
        ]);
        expect(envelopes[1]).toMatchObject({
            role: 'user',
            id: 'user-1',
            codexItemId: 'user-1',
            ev: { t: 'text', text: 'hello codex' },
        });
        expect(envelopes[2]).toMatchObject({
            role: 'agent',
            id: 'agent-1',
            turn: 'turn-1',
            codexItemId: 'agent-1',
            ev: { t: 'text', text: 'hello human' },
        });
    });

    it('backfills Codex command execution items as tool calls', () => {
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-1',
                startedAt: 100,
                items: [
                    {
                        id: 'cmd-1',
                        type: 'commandExecution',
                        command: 'pnpm test',
                        cwd: '/tmp/project',
                        aggregatedOutput: 'ok',
                    },
                ],
            }],
        });

        // B-771: the output rides on the card's tool-call-end, not a stray reasoning line.
        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'tool-call-start',
            'tool-call-end',
            'turn-end',
        ]);
        expect(envelopes[1]).toMatchObject({
            role: 'agent',
            turn: 'turn-1',
            ev: { t: 'tool-call-start', call: 'cmd-1', name: 'CodexBash' },
        });
        expect(envelopes[2]).toMatchObject({
            role: 'agent',
            turn: 'turn-1',
            ev: { t: 'tool-call-end', call: 'cmd-1', result: { text: 'ok' } },
        });
    });

    it('B-771: a failed historical command is marked isError; a running one keeps its partial output as text', () => {
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-1',
                startedAt: 100,
                items: [
                    { id: 'cmd-1', type: 'commandExecution', command: 'false', cwd: '/p', aggregatedOutput: 'boom', exitCode: 1, status: 'failed' },
                    { id: 'cmd-2', type: 'commandExecution', command: 'sleep 9', cwd: '/p', aggregatedOutput: 'partial', status: 'inProgress' },
                    { id: 'cmd-3', type: 'commandExecution', command: 'rm -rf /', cwd: '/p', aggregatedOutput: '', exitCode: null, status: 'declined' },
                ],
            }],
        } as any);
        const end = envelopes.find((e) => e.ev.t === 'tool-call-end' && e.ev.call === 'cmd-1');
        expect(end?.ev).toEqual({ t: 'tool-call-end', call: 'cmd-1', result: { text: 'boom', isError: true } });
        expect(envelopes.some((e) => e.ev.t === 'tool-call-end' && e.ev.call === 'cmd-2')).toBe(false);
        expect(envelopes.find((e) => e.ev.t === 'tool-call-end' && e.ev.call === 'cmd-3')?.ev).toEqual({ t: 'tool-call-end', call: 'cmd-3', result: { text: '', isError: true } });
        expect(envelopes.find((e) => e.id === 'cmd-2:output')?.ev).toEqual({ t: 'text', text: 'partial', thinking: true });
    });

    it('B-771: historical MCP results become text (content blocks), never "[object Object]"', () => {
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-1',
                items: [
                    { id: 'mcp-1', type: 'mcpToolCall', server: 'jina', tool: 'primer', arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: 'time: 10:00' }] } },
                    { id: 'mcp-2', type: 'mcpToolCall', server: 'jina', tool: 'primer', arguments: {}, status: 'failed', error: { message: 'denied' } },
                ],
            }],
        } as any);
        const ends = envelopes.filter((e) => e.ev.t === 'tool-call-end').map((e) => e.ev);
        expect(ends).toEqual([
            { t: 'tool-call-end', call: 'mcp-1', result: { text: 'time: 10:00' } },
            { t: 'tool-call-end', call: 'mcp-2', result: { text: 'denied', isError: true } },
        ]);
    });
});

describe('B-771: live Codex command output reaches the card', () => {
    it('exec_command_end carries aggregated output', () => {
        const end = mapCodexMcpMessageToSessionEnvelopes({ type: 'exec_command_end', call_id: 'c1', output: 'a\nb\n', exit_code: 0, status: 'completed' }, { currentTurnId: 'turn-1' });
        expect(end.envelopes.map((e) => e.ev)).toEqual([{ t: 'tool-call-end', call: 'c1', result: { text: 'a\nb\n' } }]);
    });

    it('a non-zero exit is isError with the exit code appended', () => {
        const end = mapCodexMcpMessageToSessionEnvelopes({ type: 'exec_command_end', call_id: 'c1', output: 'nope', exit_code: 2, status: 'failed' }, { currentTurnId: 'turn-1' });
        expect(end.envelopes[0].ev).toEqual({ t: 'tool-call-end', call: 'c1', result: { text: 'nope\n[exit code 2]', isError: true } });
    });

    it('legacy aggregated_output; empty successful output carries no result', () => {
        expect(mapCodexMcpMessageToSessionEnvelopes({ type: 'exec_command_end', call_id: 'c1', aggregated_output: 'x' }, { currentTurnId: 't' }).envelopes[0].ev)
            .toEqual({ t: 'tool-call-end', call: 'c1', result: { text: 'x' } });
        expect(mapCodexMcpMessageToSessionEnvelopes({ type: 'exec_command_end', call_id: 'c1', output: '', exit_code: 0 }, { currentTurnId: 't' }).envelopes[0].ev)
            .toEqual({ t: 'tool-call-end', call: 'c1' });
    });

    it('oversized output is capped and marked truncated', () => {
        const end = mapCodexMcpMessageToSessionEnvelopes({ type: 'exec_command_end', call_id: 'c1', output: '日本'.repeat(50_000), exit_code: 0 }, { currentTurnId: 't' });
        const result = (end.envelopes[0].ev as { result?: { text: string; truncated?: boolean } }).result!;
        expect(result.truncated).toBe(true);
        expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    });
});

it('preserves collaboration call completion separately from running child snapshots', () => {
    const item = {type:'collabAgentToolCall',id:'spawn-1',tool:'spawnAgent',status:'completed',model:'requested-model',prompt:'Review',receiverThreadIds:['child-1'],agentsStates:{'child-1':{status:'running'}}};
    const live = mapCodexMcpMessageToSessionEnvelopes({type:'collab_agent_item',item}, {currentTurnId:'turn-1'}).envelopes;
    expect(live.map(e=>e.ev.t)).toEqual(['tool-call-start','tool-call-end']);
    expect(live[0].ev).toMatchObject({name:'CodexCollaboration',args:{model:'requested-model',agentsStates:{'child-1':{status:'running'}}}});
    expect(live.some(e=>e.subagent)).toBe(false);
    const history = mapCodexThreadToSessionEnvelopes({turns:[{id:'turn-1',items:[item]}]} as any);
    expect(history.filter(e=>e.ev.t.startsWith('tool-call')).map(e=>e.ev)).toEqual(live.map(e=>e.ev));
    expect(mapCodexMcpMessageToSessionEnvelopes({type:'collab_agent_item',item:{...item,status:'inProgress'}},{currentTurnId:'turn-1'}).envelopes).toHaveLength(1);
});

it('delivers completed collaboration receivers after an incremental start with no receivers', () => {
    const initial = { type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', status: 'inProgress', receiverThreadIds: [], agentsStates: {} };
    const completed = { ...initial, status: 'completed', receiverThreadIds: ['child-1'], agentsStates: { 'child-1': { status: 'running' } } };
    const mapLive = (item: Record<string, unknown>) => mapCodexMcpMessageToSessionEnvelopes({ type: 'collab_agent_item', item }, { currentTurnId: 'turn-1' }).envelopes;
    const started = mapLive(initial);
    const finished = mapLive(completed);
    expect(started[0].id).not.toBe(finished[0].id);
    expect(started[0].ev).toMatchObject({ call: 'spawn-1', args: { receiverThreadIds: [] } });
    expect(finished[0].ev).toMatchObject({ call: 'spawn-1', args: { receiverThreadIds: ['child-1'] } });

    // Model message-ID deduplication at the consumer boundary. Both updates
    // must survive, while replaying the same terminal notification is stable.
    const messages = new Map([...started, ...finished, ...mapLive(completed)].map(envelope => [envelope.id, envelope]));
    expect([...messages.values()].map(e => e.ev.t)).toEqual(['tool-call-start', 'tool-call-start', 'tool-call-end']);
    const history = mapCodexThreadToSessionEnvelopes({ turns: [{ id: 'turn-1', items: [completed] }] } as any);
    expect(history.find(e => e.ev.t === 'tool-call-start')?.id).toBe('spawn-1:start');
});
