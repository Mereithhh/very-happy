import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createId, isCuid } from '@paralleldrive/cuid2';
import {
    closeClaudeTurnWithStatus,
    mapClaudeLogMessageToSessionEnvelopes,
} from './sessionProtocolMapper';

describe('mapClaudeLogMessageToSessionEnvelopes', () => {
    it('maps user text to a user text envelope', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-1',
            message: {
                role: 'user',
                content: 'hello from user',
            },
            timestamp: '2025-01-01T00:00:00.000Z',
        } as any, { currentTurnId: null });

        expect(result.currentTurnId).toBeNull();
        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].role).toBe('user');
        expect(result.envelopes[0].ev).toEqual({ t: 'text', text: 'hello from user' });
    });

    it('starts a turn and maps assistant text blocks', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-1',
            message: {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'working...' },
                    { type: 'thinking', thinking: 'internal' },
                ],
            },
            timestamp: '2025-01-01T00:00:01.000Z',
        } as any, { currentTurnId: null });

        expect(result.currentTurnId).not.toBeNull();
        expect(result.envelopes).toHaveLength(3);
        expect(result.envelopes[0].ev.t).toBe('turn-start');
        expect(result.envelopes[1].ev).toEqual({ t: 'text', text: 'working...' });
        expect(result.envelopes[2].ev).toEqual({ t: 'text', text: 'internal', thinking: true });
    });

    it('does not persist empty assistant text or thinking blocks', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-empty',
            message: {
                role: 'assistant',
                content: [
                    { type: 'text', text: '' },
                    { type: 'text', text: '  \n ' },
                    { type: 'thinking', thinking: '' },
                    { type: 'thinking', thinking: '\n  ' },
                ],
            },
            timestamp: '2025-01-01T00:00:01.000Z',
        } as any, { currentTurnId: null });

        expect(result.currentTurnId).not.toBeNull();
        expect(result.envelopes.map((envelope) => envelope.ev.t)).toEqual(['turn-start']);
    });

    it('maps tool use and tool result blocks to tool-call lifecycle', () => {
        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-2',
            message: {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
                ],
            },
        } as any, { currentTurnId: null });

        expect(started.envelopes.some((e) => e.ev.t === 'tool-call-start')).toBe(true);

        const ended = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-2',
            message: {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
                ],
            },
        } as any, { currentTurnId: started.currentTurnId });

        expect(ended.currentTurnId).toBe(started.currentTurnId);
        expect(ended.envelopes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    ev: { t: 'tool-call-end', call: 'tool-1' },
                }),
            ]),
        );
    });

    it('exposes the generated session subagent id on Agent tool calls', () => {
        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-agent-1',
            message: {
                role: 'assistant',
                content: [
                    {
                        type: 'tool_use',
                        id: 'tool-agent-1',
                        name: 'Agent',
                        input: {
                            description: 'Inspect translations',
                            prompt: 'Review all translation files',
                            mode: 'auto',
                        },
                    },
                ],
            },
        } as any, { currentTurnId: null });

        const toolCall = started.envelopes.find((envelope) => {
            return envelope.ev.t === 'tool-call-start'
                && envelope.ev.call === 'tool-agent-1';
        });

        expect(toolCall).toBeDefined();
        expect(toolCall?.ev).toEqual(expect.objectContaining({
            t: 'tool-call-start',
            name: 'Agent',
            title: 'Inspect translations',
            description: 'Inspect translations',
            args: expect.objectContaining({
                description: 'Inspect translations',
                prompt: 'Review all translation files',
                mode: 'auto',
                sessionSubagent: expect.any(String),
            }),
        }));

        if (toolCall?.ev.t === 'tool-call-start') {
            expect(isCuid(String(toolCall.ev.args.sessionSubagent))).toBe(true);
        }
    });

    it('uses parent_tool_use_id as subagent and emits subagent start', () => {
        const mappedSubagent = createId();
        const state = {
            currentTurnId: 'turn-1',
            providerSubagentToSessionSubagent: new Map<string, string>([['task-1', mappedSubagent]]),
        };

        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-side-1',
            parent_tool_use_id: 'task-1',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'sidechain text' }],
            },
        } as any, state);

        expect(result.envelopes).toHaveLength(2);
        expect(result.envelopes[0].subagent).toBe(mappedSubagent);
        expect(result.envelopes[0].ev).toEqual({ t: 'start' });
        expect(result.envelopes[1].subagent).toBe(mappedSubagent);
        expect(result.envelopes[1].ev).toEqual({ t: 'text', text: 'sidechain text' });
    });

    it('buffers subagent messages until parent Task registration is known', () => {
        const state = { currentTurnId: null };

        const buffered = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-side-buffered-1',
            parent_tool_use_id: 'task-buffer-1',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'buffer me' }],
            },
        } as any, state);
        expect(buffered.envelopes).toHaveLength(0);

        const parent = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-parent-buffered-1',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'task-buffer-1',
                    name: 'Task',
                    input: { prompt: 'run side task' },
                }],
            },
        } as any, state);

        expect(parent.envelopes.some((envelope) => {
            return envelope.ev.t === 'tool-call-start'
                && envelope.ev.call === 'task-buffer-1';
        })).toBe(false);
        const bufferedText = parent.envelopes.find((envelope) => {
            return envelope.ev.t === 'text'
                && envelope.ev.text === 'buffer me';
        });
        expect(bufferedText?.subagent).toBeDefined();
        expect(isCuid(bufferedText!.subagent!)).toBe(true);
        expect(bufferedText?.subagent).not.toBe('task-buffer-1');
    });

    it('creates and tags subagent chain from Task prompt when parent_tool_use_id is absent', () => {
        const state = { currentTurnId: null };
        const prompt = 'Search for TypeScript 5.6 features';

        const taskToolUse = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'task-parent-assistant',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'task-call-1',
                    name: 'Task',
                    input: {
                        prompt,
                        description: 'Search TypeScript docs',
                    },
                }],
            },
        } as any, state);

        expect(taskToolUse.envelopes.some((envelope) => {
            return envelope.ev.t === 'tool-call-start'
                && envelope.ev.call === 'task-call-1';
        })).toBe(false);

        const sidechainRoot = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'sidechain-root',
            isSidechain: true,
            parentUuid: null,
            message: {
                role: 'user',
                content: prompt,
            },
        } as any, state);

        expect(sidechainRoot.envelopes).toHaveLength(2);
        const mappedSubagent = sidechainRoot.envelopes[0].subagent;
        expect(mappedSubagent).toBeDefined();
        expect(isCuid(mappedSubagent!)).toBe(true);
        expect(mappedSubagent).not.toBe('task-call-1');
        expect(sidechainRoot.envelopes[0].role).toBe('agent');
        expect(sidechainRoot.envelopes[0].subagent).toBe(mappedSubagent);
        expect(sidechainRoot.envelopes[0].ev).toMatchObject({ t: 'start', title: 'Search TypeScript docs' });
        expect(sidechainRoot.envelopes[1].subagent).toBe(mappedSubagent);
        expect(sidechainRoot.envelopes[1].ev).toEqual({ t: 'text', text: prompt });

        const sidechainChild = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'sidechain-child',
            isSidechain: true,
            parentUuid: 'sidechain-root',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Subagent result' }],
            },
        } as any, state);

        expect(sidechainChild.envelopes).toHaveLength(1);
        expect(sidechainChild.envelopes[0].subagent).toBe(mappedSubagent);
        expect(sidechainChild.envelopes[0].ev).toEqual({ t: 'text', text: 'Subagent result' });
    });

    it('infers subagent for non-SDK sidechain fixture logs', () => {
        const fixturePath = join(__dirname, '__fixtures__', 'task_non_sdk.jsonl');
        const rows = readFileSync(fixturePath, 'utf8')
            .trim()
            .split('\n')
            .slice(0, 6)
            .map((line) => JSON.parse(line));

        const state = { currentTurnId: null };
        const envelopes = rows.flatMap((row) => {
            return mapClaudeLogMessageToSessionEnvelopes(row as any, state).envelopes;
        });

        const subagentRoot = envelopes.find((envelope) => {
            return envelope.ev.t === 'text'
                && envelope.ev.text.startsWith('Search the web for information about TypeScript 5.6');
        });
        expect(subagentRoot?.subagent).toBeDefined();
        expect(isCuid(subagentRoot!.subagent!)).toBe(true);
        expect(subagentRoot?.subagent).not.toBe('toolu_01EmKA8FJ7B2Ah9seGxK1Wct');

        const subagentChild = envelopes.find((envelope) => {
            return envelope.ev.t === 'text'
                && envelope.ev.text.includes("I'll search for information about TypeScript 5.6");
        });
        expect(subagentChild?.subagent).toBe(subagentRoot?.subagent);
    });

    it('emits stop for completed subagent when parent Task tool returns', () => {
        const mappedSubagent = createId();
        const state = {
            currentTurnId: 'turn-1',
            providerSubagentToSessionSubagent: new Map<string, string>([['task-2', mappedSubagent]]),
            hiddenParentToolCalls: new Set<string>(['task-2']),
        };

        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-side-2',
            parent_tool_use_id: 'task-2',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'subagent running' }],
            },
        } as any, state);

        expect(started.envelopes.some((envelope) => {
            return envelope.ev.t === 'start' && envelope.subagent === mappedSubagent;
        })).toBe(true);

        const stopped = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-parent-2',
            isSidechain: false,
            message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'task-2', content: 'done' }],
            },
        } as any, state);

        expect(stopped.envelopes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    subagent: mappedSubagent,
                    ev: { t: 'stop' },
                }),
            ]),
        );
        expect(stopped.envelopes.some((envelope) => {
            return envelope.ev.t === 'tool-call-end'
                && envelope.ev.call === 'task-2';
        })).toBe(false);
    });

    it('does not emit envelopes for summary messages', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'summary',
            summary: 'Done',
            leafUuid: 'leaf-1',
        } as any, { currentTurnId: 'turn-1' });

        expect(result.currentTurnId).toBe('turn-1');
        expect(result.envelopes).toHaveLength(0);
    });

    it('does not emit envelopes for compact summary assistant messages', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'compact-summary-1',
            isCompactSummary: true,
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Long compaction summary' }],
            },
        } as any, { currentTurnId: 'turn-1' });

        expect(result.currentTurnId).toBe('turn-1');
        expect(result.envelopes).toHaveLength(0);
    });

    it('closes an interrupted SDK result as cancelled while preserving real failures', () => {
        const interrupted = mapClaudeLogMessageToSessionEnvelopes({
            type: 'result',
            interrupted: true,
            is_error: true,
        } as any, { currentTurnId: 'turn-interrupted' });

        expect(interrupted.currentTurnId).toBeNull();
        expect(interrupted.envelopes).toHaveLength(1);
        expect(interrupted.envelopes[0].ev).toEqual({ t: 'turn-end', status: 'cancelled' });

        const failed = mapClaudeLogMessageToSessionEnvelopes({
            type: 'result',
            is_error: true,
        } as any, { currentTurnId: 'turn-failed' });
        expect(failed.envelopes[0].ev).toEqual({
            t: 'turn-end',
            status: 'failed',
            error: 'Claude turn failed',
        });
    });
});

describe('closeClaudeTurnWithStatus', () => {
    it('emits turn-end with provided status when turn is active', () => {
        const result = closeClaudeTurnWithStatus({ currentTurnId: 'turn-1' }, 'cancelled');
        expect(result.currentTurnId).toBeNull();
        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].ev).toEqual({ t: 'turn-end', status: 'cancelled' });
    });

    it('includes a failure reason when supplied', () => {
        const result = closeClaudeTurnWithStatus({ currentTurnId: 'turn-1' }, 'failed', { error: 'upstream failed' });
        expect(result.envelopes[0].ev).toEqual({ t: 'turn-end', status: 'failed', error: 'upstream failed' });
    });
});

describe('Claude SDK failure mapping', () => {
    it('preserves result errors on the failed turn-end envelope', () => {
        const state = { currentTurnId: 'turn-1' };
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'result', subtype: 'error_during_execution', is_error: true,
            errors: ['provider overloaded', 'retry later'],
        } as any, state);
        expect(result.envelopes[0].ev).toEqual({
            t: 'turn-end', status: 'failed', error: 'provider overloaded\nretry later',
        });
    });

    it('creates a failed turn when startup fails before assistant output', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'result', subtype: 'error_during_execution', is_error: true,
            errors: ['startup failed'],
        } as any, { currentTurnId: null });
        expect(result.envelopes.map((envelope) => envelope.ev)).toEqual([
            { t: 'turn-start' },
            { t: 'turn-end', status: 'failed', error: 'startup failed' },
        ]);
    });

    it('falls back to the preceding assistant error code', () => {
        const state = { currentTurnId: null as string | null };
        mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant', error: 'rate_limit', isSidechain: false,
            message: { role: 'assistant', content: [] },
        } as any, state);
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'result', subtype: 'error_during_execution', is_error: true, errors: [],
        } as any, state);
        expect(result.envelopes[0].ev).toEqual({ t: 'turn-end', status: 'failed', error: 'rate_limit' });
    });
});

describe('assistant usage stamping (B-108)', () => {
    const freshState = () => ({ currentTurnId: null });

    it('stamps per-call usage onto every envelope of an assistant line', () => {
        const state = freshState();
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a1',
            message: {
                role: 'assistant',
                model: 'claude-test',
                usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5000 },
                content: [
                    { type: 'text', text: 'hello' },
                    { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } },
                ],
            },
        } as any, state as any);
        // turn-start + text + tool-call-start
        const stamped = result.envelopes.filter((e) => (e as any).usage);
        expect(stamped.length).toBe(2); // text + tool-call-start (turn-start precedes usage resolution? no — turn-start is pushed by ensureTurn before usage computed but usage opts only on text/tool envelopes)
        for (const e of stamped) {
            expect((e as any).usage).toEqual({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5000 });
        }
    });

    it('omits usage when the line has none or a malformed shape', () => {
        const state = freshState();
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a2',
            message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'x' }] },
        } as any, state as any);
        for (const e of result.envelopes) {
            expect((e as any).usage).toBeUndefined();
        }
    });
});

describe('streamKey (B-309)', () => {
    it('stamps text and thinking envelopes with "<api message id>:<block index>"', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-1',
            message: {
                role: 'assistant',
                id: 'msg_01ABC',
                content: [
                    { type: 'thinking', thinking: 'reasoning' },
                    { type: 'text', text: 'answer' },
                ],
            },
            timestamp: '2025-01-01T00:00:01.000Z',
        } as any, { currentTurnId: 'turn-1' });

        const keys = result.envelopes.map((envelope) => envelope.streamKey);
        expect(keys).toEqual(['msg_01ABC:0', 'msg_01ABC:1']);
    });

    it('uses the ORIGINAL block index, so a skipped empty block does not shift the key', () => {
        // The web drafted from the stream, where the empty block still consumed
        // an index. Numbering by emitted envelopes instead would misalign every
        // key after the first empty block and leave stale drafts on screen.
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-2',
            message: {
                role: 'assistant',
                id: 'msg_02',
                content: [
                    { type: 'text', text: '' },
                    { type: 'text', text: 'real answer' },
                ],
            },
            timestamp: '2025-01-01T00:00:01.000Z',
        } as any, { currentTurnId: 'turn-1' });

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].streamKey).toBe('msg_02:1');
    });

    it('continues the block index across the frames the SDK splits one message into', () => {
        // Measured against the SDK: one API message arrives as several
        // `assistant` frames, one block each, while the stream numbered those
        // blocks 0,1,2… Keying each frame from its own array would put every
        // envelope at index 0 — the answer's draft would never be claimed and
        // would sit duplicated under the real message until the sweep.
        const state = { currentTurnId: 'turn-1' };
        const frame = (blocks: unknown[]) => mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-split',
            message: { role: 'assistant', id: 'msg_split', content: blocks },
            timestamp: '2025-01-01T00:00:01.000Z',
        } as any, state as any);

        const first = frame([{ type: 'thinking', thinking: 'reasoning' }]);
        const second = frame([{ type: 'tool_use', id: 'call-1', name: 'Bash', input: {} }]);
        const third = frame([{ type: 'text', text: 'the answer' }]);

        expect(first.envelopes.map((e) => e.streamKey)).toEqual(['msg_split:0']);
        // The tool_use frame carries no key but still consumed index 1.
        expect(second.envelopes.every((e) => e.streamKey === undefined)).toBe(true);
        expect(third.envelopes.map((e) => e.streamKey)).toEqual(['msg_split:2']);
    });

    it('restarts the cursor when a new message id begins', () => {
        const state = { currentTurnId: 'turn-1' };
        const frame = (id: string, blocks: unknown[]) => mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: `a-${id}`,
            message: { role: 'assistant', id, content: blocks },
            timestamp: '2025-01-01T00:00:01.000Z',
        } as any, state as any);

        frame('msg_a', [{ type: 'text', text: 'first' }]);
        const next = frame('msg_b', [{ type: 'text', text: 'second' }]);

        expect(next.envelopes.map((e) => e.streamKey)).toEqual(['msg_b:0']);
    });

    it('omits the key when the assistant message has no id (nothing to claim)', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-3',
            message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
            timestamp: '2025-01-01T00:00:01.000Z',
        } as any, { currentTurnId: 'turn-1' });

        expect(result.envelopes[0].streamKey).toBeUndefined();
    });

    it('does not stamp tool-call envelopes — only text is ever drafted', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-4',
            message: {
                role: 'assistant',
                id: 'msg_04',
                content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } }],
            },
            timestamp: '2025-01-01T00:00:01.000Z',
        } as any, { currentTurnId: 'turn-1' });

        const toolStart = result.envelopes.find((envelope) => envelope.ev.t === 'tool-call-start');
        expect(toolStart).toBeDefined();
        expect(toolStart!.streamKey).toBeUndefined();
    });
});

describe('streamKey and sidechain interleaving (B-309)', () => {
    it('a sub-agent message between two frames of one main message does not reset the cursor', () => {
        // The mapper state is shared by both chains. Letting a sidechain frame
        // move the cursor would hand the main message's second frame the same
        // key as its first — the real message would then claim the wrong
        // draft and the answer would sit duplicated until the sweep.
        const state = { currentTurnId: 'turn-1' };
        const main = (blocks: unknown[]) => mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-main',
            message: { role: 'assistant', id: 'msg_main', content: blocks },
            timestamp: '2025-01-01T00:00:01.000Z',
        } as any, state as any);

        const first = main([{ type: 'thinking', thinking: 'reasoning' }]);
        mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-sub',
            isSidechain: true,
            parent_tool_use_id: 'call-1',
            message: { role: 'assistant', id: 'msg_sub', content: [{ type: 'text', text: 'sub-agent says hi' }] },
            timestamp: '2025-01-01T00:00:02.000Z',
        } as any, state as any);
        const second = main([{ type: 'text', text: 'the answer' }]);

        expect(first.envelopes.map((e) => e.streamKey)).toEqual(['msg_main:0']);
        expect(second.envelopes.map((e) => e.streamKey)).toEqual(['msg_main:1']);
    });

    it('never stamps a sidechain envelope — there is no draft for it to claim', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-sub',
            isSidechain: true,
            parent_tool_use_id: 'call-1',
            message: { role: 'assistant', id: 'msg_sub', content: [{ type: 'text', text: 'hi' }] },
            timestamp: '2025-01-01T00:00:01.000Z',
        } as any, { currentTurnId: 'turn-1' } as any);

        expect(result.envelopes.every((e) => e.streamKey === undefined)).toBe(true);
    });
});
