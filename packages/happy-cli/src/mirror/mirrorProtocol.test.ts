import { describe, it, expect } from 'vitest';
import {
    parseTerminalHookPayload,
    decideMirrorBinding,
    mirrorLineKey,
    mirrorLocalId,
    extractCompleteLines,
    decideBackfill,
    type MirrorBindingSnapshot,
} from './mirrorProtocol';
import type { RawJSONLines } from '@/claude/types';

const startPayload = (over: Record<string, unknown> = {}) => ({
    hook_event_name: 'SessionStart',
    session_id: 'c1',
    transcript_path: '/tmp/p/c1.jsonl',
    cwd: '/tmp/p',
    source: 'startup',
    terminalId: 't1',
    ...over,
});

describe('parseTerminalHookPayload', () => {
    it('parses a SessionStart payload', () => {
        const ev = parseTerminalHookPayload(startPayload());
        expect(ev).toEqual({
            event: 'SessionStart',
            claudeSessionId: 'c1',
            terminalId: 't1',
            transcriptPath: '/tmp/p/c1.jsonl',
            cwd: '/tmp/p',
            source: 'startup',
        });
    });

    it('parses SessionEnd and camelCase sessionId', () => {
        const ev = parseTerminalHookPayload({ hook_event_name: 'SessionEnd', sessionId: 'c2', terminalId: 't1' });
        expect(ev?.event).toBe('SessionEnd');
        expect(ev?.claudeSessionId).toBe('c2');
    });

    it('rejects payloads missing event/session/terminal', () => {
        expect(parseTerminalHookPayload(null)).toBeNull();
        expect(parseTerminalHookPayload({})).toBeNull();
        expect(parseTerminalHookPayload(startPayload({ hook_event_name: 'PreToolUse' }))).toBeNull();
        expect(parseTerminalHookPayload(startPayload({ session_id: '' }))).toBeNull();
        expect(parseTerminalHookPayload(startPayload({ terminalId: undefined }))).toBeNull();
    });
});

describe('decideMirrorBinding', () => {
    const active: MirrorBindingSnapshot = { status: 'active', claudeSessionId: 'c1' };
    const ended: MirrorBindingSnapshot = { status: 'ended', claudeSessionId: 'c1' };
    const ev = (over: Record<string, unknown> = {}) =>
        parseTerminalHookPayload(startPayload(over))!;

    it('startup without binding → create', () => {
        expect(decideMirrorBinding(ev(), null)).toEqual({ action: 'create' });
    });

    it('startup over an existing binding → create (replaces old)', () => {
        expect(decideMirrorBinding(ev({ session_id: 'c2' }), active))
            .toEqual({ action: 'create', replaces: active });
    });

    it('clear is a fresh conversation → create', () => {
        expect(decideMirrorBinding(ev({ session_id: 'c2', source: 'clear' }), active).action).toBe('create');
    });

    it('resume/compact continue the binding (also when ended — revive)', () => {
        expect(decideMirrorBinding(ev({ session_id: 'c2', source: 'resume' }), active)).toEqual({ action: 'continue' });
        expect(decideMirrorBinding(ev({ session_id: 'c2', source: 'compact' }), active)).toEqual({ action: 'continue' });
        expect(decideMirrorBinding(ev({ session_id: 'c2', source: 'resume' }), ended)).toEqual({ action: 'continue' });
    });

    it('unknown non-fresh source defaults to continue', () => {
        expect(decideMirrorBinding(ev({ session_id: 'c2', source: 'fork-esc' }), active)).toEqual({ action: 'continue' });
    });

    it('duplicate SessionStart for the bound session → ignore', () => {
        expect(decideMirrorBinding(ev(), active).action).toBe('ignore');
    });

    it('SessionEnd: bound id ends, stale id ignored, no binding ignored, double end ignored', () => {
        const end = parseTerminalHookPayload({ hook_event_name: 'SessionEnd', session_id: 'c1', terminalId: 't1' })!;
        expect(decideMirrorBinding(end, active)).toEqual({ action: 'end' });
        expect(decideMirrorBinding(end, { status: 'active', claudeSessionId: 'c9' }).action).toBe('ignore');
        expect(decideMirrorBinding(end, null).action).toBe('ignore');
        expect(decideMirrorBinding(end, ended).action).toBe('ignore');
    });
});

describe('mirrorLineKey / mirrorLocalId', () => {
    it('uses uuid for user/assistant/system and leafUuid for summary', () => {
        expect(mirrorLineKey({ type: 'user', uuid: 'u1', message: { content: 'hi' } } as RawJSONLines)).toBe('u1');
        expect(mirrorLineKey({ type: 'assistant', uuid: 'a1' } as RawJSONLines)).toBe('a1');
        expect(mirrorLineKey({ type: 'system', uuid: 's1' } as RawJSONLines)).toBe('s1');
        expect(mirrorLineKey({ type: 'summary', summary: 'x', leafUuid: 'l1' } as RawJSONLines)).toBe('summary-l1');
    });

    it('result lines (SDK-only) have no stable key', () => {
        expect(mirrorLineKey({ type: 'result' } as RawJSONLines)).toBeNull();
    });

    it('localId embeds the envelope index (multi-envelope lines must not collide)', () => {
        expect(mirrorLocalId('u1', 0)).toBe('mirror:u1:0');
        expect(mirrorLocalId('u1', 1)).toBe('mirror:u1:1');
        expect(mirrorLocalId('u1', 0)).toBe(mirrorLocalId('u1', 0)); // deterministic replay
    });
});

describe('extractCompleteLines', () => {
    it('returns only complete lines and the exact bytes consumed', () => {
        const buf = Buffer.from('{"a":1}\n{"b":2}\n{"part', 'utf-8');
        const r = extractCompleteLines(buf);
        expect(r.lines).toEqual(['{"a":1}', '{"b":2}']);
        expect(r.consumedBytes).toBe(Buffer.byteLength('{"a":1}\n{"b":2}\n'));
    });

    it('no newline → nothing consumed', () => {
        const r = extractCompleteLines(Buffer.from('{"partial'));
        expect(r.lines).toEqual([]);
        expect(r.consumedBytes).toBe(0);
    });

    it('is multibyte-safe when the read ends mid-character', () => {
        const whole = Buffer.from('{"t":"中文"}\n{"t":"漢', 'utf-8');
        const r = extractCompleteLines(whole);
        expect(r.lines).toEqual(['{"t":"中文"}']);
        expect(JSON.parse(r.lines[0]).t).toBe('中文');
    });

    it('drops blank lines', () => {
        const r = extractCompleteLines(Buffer.from('\n \n{"a":1}\n', 'utf-8'));
        expect(r.lines).toEqual(['{"a":1}']);
    });
});

describe('decideBackfill', () => {
    it('short history replays fully, untruncated', () => {
        expect(decideBackfill([1, 2, 3], 500)).toEqual({ replay: [1, 2, 3], truncated: false });
    });
    it('long history keeps only the tail and reports truncation', () => {
        const msgs = Array.from({ length: 12 }, (_, i) => i);
        expect(decideBackfill(msgs, 5)).toEqual({ replay: [7, 8, 9, 10, 11], truncated: true });
    });
    it('cap of 0 replays nothing', () => {
        expect(decideBackfill([1, 2], 0)).toEqual({ replay: [], truncated: true });
    });
});
