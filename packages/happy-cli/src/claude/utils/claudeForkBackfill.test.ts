import { describe, expect, it } from 'vitest';
import { analyzeLatestTurn, type LogEntry } from '@/sessions/turnState';
import { closeClaudeTurnWithStatus, mapClaudeLogMessageToSessionEnvelopes, type ClaudeSessionProtocolState } from './sessionProtocolMapper';
import { replayClaudeForkJsonl } from './claudeForkBackfill';
import type { RawJSONLines } from '../types';

const history = [
    { type: 'user', uuid: 'h-u1', message: { role: 'user', content: 'what is 2+2?' } },
    { type: 'assistant', uuid: 'h-a1', message: { role: 'assistant', content: [{ type: 'text', text: '4' }] } },
].map((line) => JSON.stringify(line)).join('\n') + '\n';

/** The server log of a fork: replay → first prompt (web/CLI outbox) → its live SDK turn. */
function forkLog(closeTurn: boolean): LogEntry[] {
    const state: ClaudeSessionProtocolState = { currentTurnId: null };
    const bodies: unknown[] = [];
    const push = (envelopes: unknown[]) => { for (const content of envelopes) bodies.push({ role: 'session', content }); };
    const count = replayClaudeForkJsonl(history, {
        send: (line) => push(mapClaudeLogMessageToSessionEnvelopes(line, state).envelopes),
        closeTurn: () => { if (closeTurn) push(closeClaudeTurnWithStatus(state, 'completed').envelopes); },
    });
    expect(count).toBe(2);
    bodies.push({ role: 'user', content: { type: 'text', text: 'and 3+3?' } });
    push(mapClaudeLogMessageToSessionEnvelopes({ type: 'assistant', uuid: 'n-a1', message: { role: 'assistant', content: [{ type: 'text', text: '6' }] } } as RawJSONLines, state).envelopes);
    push(mapClaudeLogMessageToSessionEnvelopes({ type: 'result', subtype: 'success', uuid: 'n-r1' } as unknown as RawJSONLines, state).envelopes);
    push(closeClaudeTurnWithStatus(state, 'completed').envelopes);
    return bodies.map((body, i) => ({ seq: i + 1, body }));
}

describe('fork backfill closes the replayed turn (B-495)', () => {
    it('the first real turn on a fork ends for sessions read --wait', () => {
        const turn = analyzeLatestTurn(forkLog(true));
        expect(turn).toMatchObject({ ended: true, status: 'completed', answer: '6' });
    });

    it('without closing, the replay leaves the first turn unending (the reported hang)', () => {
        expect(analyzeLatestTurn(forkLog(false)).ended).toBe(false);
    });

    it('closes nothing when nothing was replayed', () => {
        let closed = 0;
        expect(replayClaudeForkJsonl('not json\n\n', { send: () => {}, closeTurn: () => { closed += 1; } })).toBe(0);
        expect(closed).toBe(0);
    });
});
