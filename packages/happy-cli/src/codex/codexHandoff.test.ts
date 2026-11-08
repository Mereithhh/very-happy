import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { extractCodexHandoff, findCodexRollout, HANDOFF_RECENT_MESSAGES, readCodexHandoff } from './codexHandoff';

const line = (ordinal: number, type: string, payload: unknown) => JSON.stringify({ timestamp: '2026-11-08T00:00:00.000Z', ordinal, type, payload });
const msg = (ordinal: number, role: string, text: string) => line(ordinal, 'response_item', {
    type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
});

describe('B-901 codex handoff from a rollout', () => {
    it('keeps the latest compaction summary (without Codex preamble) and the recent conversation', () => {
        const lines = [
            line(0, 'session_meta', { id: 't' }),
            msg(1, 'developer', 'system stuff'),
            msg(2, 'user', '<environment_context>cwd</environment_context>'),
            msg(3, 'user', `archive the bucket\n\n${CHANGE_TITLE_INSTRUCTION}\n\ntodo skill`),
            line(4, 'response_item', { type: 'function_call_output', call_id: 'c', output: 'x'.repeat(50_000) }),
            line(5, 'event_msg', { type: 'item_completed', item: { aggregatedOutput: '"type":"compacted" '.repeat(10) } }),
            line(6, 'compacted', { message: 'old summary' }),
            msg(7, 'assistant', '## Progress\n- 40% archived'),
            line(8, 'compacted', { message: 'Another language model started… use the information in this summary to assist with your own analysis:\n## Progress\n- 40% archived' }),
            msg(9, 'user', '现在什么进展'),
            msg(10, 'assistant', '还在跑'),
        ];
        expect(extractCodexHandoff(lines)).toEqual({
            summary: '## Progress\n- 40% archived',
            recent: [
                { role: 'user', text: 'archive the bucket' },
                { role: 'user', text: '现在什么进展' },
                { role: 'assistant', text: '还在跑' },
            ],
        });
    });

    it('bounds the recent messages and their length; survives junk lines', () => {
        const lines = ['not json', ...Array.from({ length: 30 }, (_, i) => msg(i, 'user', `${i}:${'y'.repeat(3000)}`))];
        const handoff = extractCodexHandoff(lines);
        expect(handoff.summary).toBeNull();
        expect(handoff.recent).toHaveLength(HANDOFF_RECENT_MESSAGES);
        expect(handoff.recent[0].text.startsWith('18:')).toBe(true);
        expect(handoff.recent[0].text.length).toBeLessThanOrEqual(1501);
    });

    it('finds the rollout by thread id under sessions/ or archived_sessions/ and streams it', async () => {
        const home = mkdtempSync(join(tmpdir(), 'b901-'));
        mkdirSync(join(home, 'sessions/2026/11/08'), { recursive: true });
        mkdirSync(join(home, 'archived_sessions'), { recursive: true });
        const live = join(home, 'sessions/2026/11/08/rollout-2026-11-08T10-00-00-01a1-live-0001.jsonl');
        writeFileSync(live, [msg(0, 'user', 'hi'), msg(1, 'assistant', 'hello')].join('\n') + '\n');
        const archived = join(home, 'archived_sessions/rollout-2026-11-01T10-00-00-01a1-old-0002.jsonl');
        writeFileSync(archived, msg(0, 'user', 'old') + '\n');
        expect(await findCodexRollout('01a1-live-0001', home)).toBe(live);
        expect(await findCodexRollout('01a1-old-0002', home)).toBe(archived);
        expect(await findCodexRollout('../../etc', home)).toBeNull();
        expect(await findCodexRollout('01a1-none-0003', home)).toBeNull();
        expect((await readCodexHandoff(live)).recent).toEqual([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }]);
    });
});
