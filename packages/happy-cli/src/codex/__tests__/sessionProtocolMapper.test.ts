import { describe, expect, it } from 'vitest';
import { createId, isCuid } from '@paralleldrive/cuid2';
import {
    mapCodexMcpMessageToSessionEnvelopes,
    mapCodexProcessorMessageToSessionEnvelopes,
    mapCodexThreadToSessionEnvelopes,
} from '../utils/sessionProtocolMapper';

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

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'tool-call-start',
            'text',
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
            ev: { t: 'text', text: 'ok', thinking: true },
        });
        expect(envelopes[3]).toMatchObject({
            role: 'agent',
            turn: 'turn-1',
            ev: { t: 'tool-call-end', call: 'cmd-1' },
        });
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
