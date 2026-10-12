import { describe, expect, it } from 'vitest';
import { TITLE_PROMPT_PREFIX } from '@/claude/utils/oneShotPrompts';
import {
    emptyDocState,
    extractClaudeLine,
    extractCodexLine,
    MAX_MESSAGE_CHARS,
    MAX_SESSION_CHARS,
} from './extract';

const j = (v: unknown) => JSON.stringify(v);

describe('extractClaudeLine (B-549)', () => {
    it('keeps user/assistant text and metadata, drops tool traffic, thinking and side chains', () => {
        const s = emptyDocState();
        extractClaudeLine(s, j({ type: 'user', cwd: '/work/app', gitBranch: 'main', entrypoint: 'cli', version: '2.1', timestamp: '2026-09-01T00:00:00Z',
            message: { role: 'user', content: '<system-reminder>ignore me</system-reminder>How do I migrate the daemon?' } }));
        extractClaudeLine(s, j({ type: 'assistant', timestamp: '2026-09-01T00:00:05Z', message: { content: [
            { type: 'thinking', thinking: 'secret reasoning' },
            { type: 'text', text: 'Use the handover path.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ] } }));
        extractClaudeLine(s, j({ type: 'user', message: { content: [{ type: 'tool_result', content: 'giant tool output' }] } }));
        extractClaudeLine(s, j({ type: 'assistant', isSidechain: true, message: { content: 'sub-agent chatter' } }));
        extractClaudeLine(s, j({ type: 'summary', summary: 'Daemon migration' }));
        extractClaudeLine(s, '{"type":"user","message":{"content":"torn'); // half-written tail

        expect(s.meta).toMatchObject({ cwd: '/work/app', gitBranch: 'main', entrypoint: 'cli', version: '2.1', summary: 'Daemon migration', firstPrompt: 'How do I migrate the daemon?' });
        expect(s.meta.startedAt).toBe(Date.parse('2026-09-01T00:00:00Z'));
        expect(s.msgs).toEqual([
            { r: 'u', t: Date.parse('2026-09-01T00:00:00Z'), x: 'How do I migrate the daemon?' },
            { r: 'a', t: Date.parse('2026-09-01T00:00:05Z'), x: 'Use the handover path.' },
        ]);
        expect(s.chars).toBe('How do I migrate the daemon?'.length + 'Use the handover path.'.length);
    });

    it("skips very-happy's own one-shot transcripts as a whole", () => {
        const s = emptyDocState();
        extractClaudeLine(s, j({ type: 'user', cwd: '/x', message: { content: `${TITLE_PROMPT_PREFIX}: hello` } }));
        extractClaudeLine(s, j({ type: 'assistant', message: { content: 'Greeting' } }));
        expect(s.meta.skip).toBe('one-shot');
        expect(s.msgs).toEqual([]);
    });

    it('caps one message and the whole session', () => {
        const s = emptyDocState();
        extractClaudeLine(s, j({ type: 'user', cwd: '/x', message: { content: 'a'.repeat(MAX_MESSAGE_CHARS + 50) } }));
        expect(s.msgs[0].x).toHaveLength(MAX_MESSAGE_CHARS);
        const big = emptyDocState();
        const per = MAX_MESSAGE_CHARS;
        const n = Math.ceil(MAX_SESSION_CHARS / per) + 2;
        for (let i = 0; i < n; i++) extractClaudeLine(big, j({ type: 'assistant', message: { content: 'b'.repeat(per) } }));
        expect(big.full).toBe(true);
        expect(big.chars).toBeLessThanOrEqual(MAX_SESSION_CHARS);
    });
});

describe('extractCodexLine (B-549)', () => {
    const meta = (extra: Record<string, unknown> = {}) => j({ timestamp: '2026-09-02T00:00:00Z', type: 'session_meta', payload: {
        id: '01A0637D-BFDD-7423-8DA5-3EEA15CA8DD7', timestamp: '2026-09-02T00:00:01Z', cwd: '/work/codex', originator: 'codex-tui', source: 'cli', cli_version: '0.154.0',
        git: { branch: 'dev' }, base_instructions: { text: 'x'.repeat(1000) }, ...extra } });

    it('indexes response_item user/assistant messages, skipping harness blocks', () => {
        const s = emptyDocState();
        extractCodexLine(s, meta());
        extractCodexLine(s, j({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev rules' }] } }));
        extractCodexLine(s, j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /work\n<INSTRUCTIONS>x</INSTRUCTIONS>' }] } }));
        extractCodexLine(s, j({ type: 'response_item', timestamp: '2026-09-02T00:00:09Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修复 relay 的超时问题' }] } }));
        extractCodexLine(s, j({ type: 'event_msg', payload: { type: 'user_message', message: '修复 relay 的超时问题' } }));
        extractCodexLine(s, j({ type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'hidden' }] } }));
        extractCodexLine(s, j({ type: 'response_item', payload: { type: 'function_call_output', output: 'tool output' } }));
        extractCodexLine(s, j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已把超时改成 25 秒' }] } }));

        expect(s.meta).toMatchObject({ id: '01a0637d-bfdd-7423-8da5-3eea15ca8dd7', cwd: '/work/codex', originator: 'codex-tui', entrypoint: 'cli', gitBranch: 'dev', version: '0.154.0', firstPrompt: '修复 relay 的超时问题' });
        expect(s.meta.startedAt).toBe(Date.parse('2026-09-02T00:00:01Z'));
        expect(s.msgs.map((m) => [m.r, m.x])).toEqual([['u', '修复 relay 的超时问题'], ['a', '已把超时改成 25 秒']]);
        expect(s.msgs[0].t).toBe(Date.parse('2026-09-02T00:00:09Z'));
    });

    it('marks non-rollouts and Codex sub-threads as skipped', () => {
        const notRollout = emptyDocState();
        extractCodexLine(notRollout, j({ type: 'event_msg', payload: {} }));
        expect(notRollout.meta.skip).toBe('not-rollout');

        const sub = emptyDocState();
        extractCodexLine(sub, meta({ thread_source: 'subagent' }));
        extractCodexLine(sub, j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] } }));
        expect(sub.meta.skip).toBe('subthread');
        expect(sub.msgs).toEqual([]);
    });
});
