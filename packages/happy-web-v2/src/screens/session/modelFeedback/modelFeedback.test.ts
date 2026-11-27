import { describe, expect, it } from 'vitest';
import { normalizeRawMessage } from '@/sync/typesRaw';
import { modelFeedbackBody, showsModelFeedback } from './modelFeedbackPolicy';
import type { AgentTextMessage } from '@/sync/typesMessage';

const turnEnd = (ev: Record<string, unknown>) => normalizeRawMessage('raw-1', null, 1, {
    role: 'session',
    content: { type: 'session', data: { id: 'envelope-1', time: 2, role: 'agent', turn: 'turn-1', ev: { t: 'turn-end', status: 'completed', ...ev } } },
} as never);

describe('B-980 turn-end → ready turnMeta', () => {
    it('carries the turn id and tagged request ids', () => {
        expect(turnEnd({ costUsd: 0.1, modelRequestIds: ['r1'] })).toEqual(expect.objectContaining({
            content: expect.objectContaining({ type: 'ready', turnMeta: expect.objectContaining({ turnId: 'turn-1', modelRequestIds: ['r1'], costUsd: 0.1 }) }),
        }));
    });
    it('tagged ids alone are enough to carry the turn id', () => {
        expect(turnEnd({ modelRequestIds: ['r1'] })).toEqual(expect.objectContaining({ content: expect.objectContaining({ turnMeta: { turnId: 'turn-1', modelRequestIds: ['r1'] } }) }));
    });
    it('a malformed id list never drops the turn end', () => {
        expect(turnEnd({ costUsd: 0.1, modelRequestIds: 'nope' })).toEqual(expect.objectContaining({ content: expect.objectContaining({ type: 'ready' }) }));
    });
});

describe('showsModelFeedback', () => {
    const tagged = { turnId: 't', modelRequestIds: ['r'] };
    it('off unless the operator enabled it and the turn is known', () => {
        expect(showsModelFeedback(null, tagged)).toBe(false);
        expect(showsModelFeedback({ modelFeedback: { enabled: false, scope: 'all' } }, tagged)).toBe(false);
        expect(showsModelFeedback({ modelFeedback: { enabled: true, scope: 'all' } }, { turnId: undefined })).toBe(false);
    });
    it('tagged scope needs request ids; all scope does not', () => {
        expect(showsModelFeedback({ modelFeedback: { enabled: true, scope: 'tagged' } }, tagged)).toBe(true);
        expect(showsModelFeedback({ modelFeedback: { enabled: true, scope: 'tagged' } }, { turnId: 't' })).toBe(false);
        expect(showsModelFeedback({ modelFeedback: { enabled: true, scope: 'all' } }, { turnId: 't' })).toBe(true);
    });
});

describe('modelFeedbackBody', () => {
    it('sends the ids the gateway joins on and what the session ran, no text of the answer', () => {
        const message = { kind: 'agent-text', id: 'm', localId: null, createdAt: 5, seq: 7, text: 'secret answer', turnId: 'turn-1', modelRequestIds: ['r1'], meta: { model: 'm-1' } } as unknown as AgentTextMessage;
        const session = { metadata: { flavor: 'claude', agentProfile: { id: 'a1', label: 'Gateway', kind: 'claude-api', status: 'active' } } } as never;
        const body = modelFeedbackBody(session, message, 's1', 'down', '  wrong  ');
        expect(body).toEqual({ sessionId: 's1', turnId: 'turn-1', rating: 'down', comment: 'wrong', requestIds: ['r1'], model: 'm-1', reportedModel: null, agent: 'claude', accountProfile: { id: 'a1', label: 'Gateway', kind: 'claude-api' }, messageSeq: 7, answeredAt: 5 });
        expect(JSON.stringify(body)).not.toContain('secret answer');
    });
});
