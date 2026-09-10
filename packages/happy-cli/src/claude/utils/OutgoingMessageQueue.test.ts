import { describe, expect, it } from 'vitest';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { OutgoingMessageQueue } from './OutgoingMessageQueue';
import { SDKToLogConverter } from './sdkToLogConverter';
import { mapClaudeLogMessageToSessionEnvelopes, type ClaudeSessionProtocolState } from './sessionProtocolMapper';

describe('SDK lifecycle delivery through the outgoing queue', () => {
    it.each(['Agent', 'Bash'])('keeps %s running after its async result and delivers the terminal notification', async (name) => {
        const state: ClaudeSessionProtocolState = { currentTurnId: null, now: () => 1_000 };
        const envelopes: SessionEnvelope[] = [];
        const sent: string[] = [];
        const converter = new SDKToLogConverter({ sessionId: 'sdk-test', cwd: process.cwd(), gitBranch: 'test' });
        const queue = new OutgoingMessageQueue(message => {
            sent.push(message.type === 'system' ? message.subtype : message.type);
            const mapped = mapClaudeLogMessageToSessionEnvelopes(message, state);
            state.currentTurnId = mapped.currentTurnId;
            envelopes.push(...mapped.envelopes);
        });
        const enqueue = (message: any, delay?: number) => {
            const converted = converter.convert(message);
            expect(converted).not.toBeNull();
            queue.enqueue(converted, delay ? { delay, toolCallIds: ['call-1'] } : undefined);
        };
        try {
            enqueue({
                type: 'assistant', uuid: 'assistant-1', message: {
                    role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name,
                        input: name === 'Bash' ? { command: 'sleep 5', run_in_background: true }
                            : { description: 'Review', prompt: 'Review the change', run_in_background: true } }],
                },
            }, 250);
            enqueue({ type: 'system', subtype: 'task_started', uuid: 'started-1', task_id: 'task-1', tool_use_id: 'call-1',
                task_type: name === 'Bash' ? 'local_bash' : 'local_agent', description: 'Background work' });
            enqueue({ type: 'system', subtype: 'task_updated', uuid: 'updated-1', task_id: 'task-1', tool_use_id: 'call-1',
                patch: { is_backgrounded: true } });
            enqueue({ type: 'system', subtype: 'task_progress', uuid: 'progress-1', task_id: 'task-1', tool_use_id: 'call-1',
                usage: { tool_uses: 2, total_tokens: 10, duration_ms: 20 }, last_tool_name: 'Read' });
            enqueue({ type: 'user', uuid: 'stub-1', tool_use_result: { status: 'async_launched' },
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Running in background' }] } });
            await queue.flush();

            expect(sent).toEqual(['assistant', 'task_started', 'task_updated', 'task_progress', 'user']);
            const call = envelopes.find(e => e.ev.t === 'tool-call-start');
            if (call?.ev.t !== 'tool-call-start') throw new Error('Missing tool call');
            const subagent = call.ev.args.sessionSubagent;
            expect(typeof subagent).toBe('string');
            expect(envelopes.find(e => e.ev.t === 'start')).toMatchObject({ subagent });
            expect(envelopes.find(e => e.ev.t === 'progress')).toMatchObject({ subagent, ev: { toolUses: 2 } });
            expect(envelopes.some(e => e.ev.t === 'stop')).toBe(false);

            enqueue({ type: 'system', subtype: 'task_notification', uuid: 'done-1', task_id: 'task-1', tool_use_id: 'call-1', status: 'completed' });
            await queue.flush();
            expect(envelopes.at(-1)).toMatchObject({ subagent, ev: { t: 'stop', status: 'completed' } });
        } finally {
            queue.destroy();
        }
    });

    it('still drops housekeeping system frames', async () => {
        const sent: unknown[] = [];
        const queue = new OutgoingMessageQueue(message => sent.push(message));
        try {
            for (const subtype of ['init', 'status', 'thinking_tokens', 'background_tasks_changed']) {
                queue.enqueue({ type: 'system', subtype });
            }
            await queue.flush();
            expect(sent).toEqual([]);
        } finally {
            queue.destroy();
        }
    });
});
