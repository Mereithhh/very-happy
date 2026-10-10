import { describe, expect, it } from 'vitest';
import {
    chainRewindRecord,
    decideLineageRepair,
    decideRewind,
    parseRewindRecord,
    REWIND_CONFIRM_MS,
    tombstoneRequestIds,
    transcriptLineage,
    visibleUserLocalIds,
    type LogRecord,
    type RewindRecord,
} from './rewindReconcile';

const record: RewindRecord = {
    requestId: 'req-1',
    action: 'edit',
    sourceClaudeSessionId: 'src',
    claudeSessionId: 'copy',
    at: 1_000,
    state: 'pending',
};

const user = (seq: number, localId: string | null): LogRecord => ({ seq, localId, body: { role: 'user', content: { type: 'text', text: `t${seq}` } } });
const drop = (seq: number, ev: Record<string, unknown>): LogRecord => ({
    seq,
    localId: `drop-${seq}`,
    body: { role: 'session', content: { type: 'session', data: { id: 'e', time: 0, role: 'user', ev: { t: 'transcript-drop', ...ev } } } },
});
const agent = (seq: number): LogRecord => ({ seq, localId: null, body: { role: 'agent', content: { type: 'output' } } });

const prompt = (uuid: string | undefined, sessionId: string, text = 'hi') => JSON.stringify({ type: 'user', uuid, sessionId, message: { role: 'user', content: text } });
const reply = (uuid: string, sessionId: string) => JSON.stringify({ type: 'assistant', uuid, sessionId, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });

describe('decideRewind (B-544)', () => {
    it('confirms when a tombstone with the same requestId was seen', () => {
        expect(decideRewind(record, new Set(['req-1']), 2_000, 'copy')).toEqual({ kind: 'confirm' });
        // confirm wins even after the deadline
        expect(decideRewind(record, new Set(['req-1']), 1_000 + REWIND_CONFIRM_MS + 5, 'copy')).toEqual({ kind: 'confirm' });
    });

    it('waits until the deadline, then reverts to the source conversation', () => {
        expect(decideRewind(record, new Set(['other']), 31_000, 'copy')).toEqual({ kind: 'wait', ms: REWIND_CONFIRM_MS - 30_000 });
        expect(decideRewind(record, new Set(), 1_000 + REWIND_CONFIRM_MS, 'copy')).toEqual({ kind: 'revert', to: 'src' });
    });

    it('reverts a fresh-conversation rewind (claudeSessionId null) too', () => {
        expect(decideRewind({ ...record, claudeSessionId: null }, new Set(), 1e9, null)).toEqual({ kind: 'revert', to: 'src' });
    });

    it('closes without switching when the agent already moved to another conversation', () => {
        expect(decideRewind(record, new Set(), 1e9, 'someone-else')).toEqual({ kind: 'supersede' });
    });

    it('does nothing without a pending record (old web sends no requestId → no record)', () => {
        expect(decideRewind(null, new Set(), 1e9, 'copy')).toEqual({ kind: 'none' });
        expect(decideRewind({ ...record, state: 'confirmed' }, new Set(), 1e9, 'copy')).toEqual({ kind: 'none' });
        expect(decideRewind({ ...record, state: 'reverted' }, new Set(), 1e9, 'copy')).toEqual({ kind: 'none' });
    });

    it('a rewind on top of a pending one reverts to the last CONFIRMED conversation', () => {
        const next: RewindRecord = { ...record, requestId: 'req-2', sourceClaudeSessionId: 'copy', claudeSessionId: 'copy-2', at: 5_000 };
        expect(chainRewindRecord(next, record).sourceClaudeSessionId).toBe('src');
        expect(chainRewindRecord(next, { ...record, state: 'confirmed' }).sourceClaudeSessionId).toBe('copy');
        expect(chainRewindRecord(next, null)).toBe(next);
    });

    it('parses only well-formed records', () => {
        expect(parseRewindRecord(record)).toEqual(record);
        expect(parseRewindRecord({ ...record, claudeSessionId: null })).toMatchObject({ claudeSessionId: null });
        expect(parseRewindRecord(null)).toBeNull();
        expect(parseRewindRecord({ ...record, requestId: '' })).toBeNull();
        expect(parseRewindRecord({ ...record, action: 'nope' })).toBeNull();
        expect(parseRewindRecord({ ...record, at: 'x' })).toBeNull();
    });
});

describe('server log helpers', () => {
    it('collects requestIds from transcript-drop tombstones only', () => {
        const log = [user(1, 'a'), drop(3, { fromSeq: 1, reason: 'edit', requestId: 'req-1' }), drop(4, { fromSeq: 2 }), agent(5)];
        expect([...tombstoneRequestIds(log)]).toEqual(['req-1']);
    });

    it('visible user prompts exclude tombstoned ranges (open-ended = up to the tombstone)', () => {
        const log = [user(1, 'a'), agent(2), user(3, 'b'), agent(4), drop(5, { fromSeq: 3 }), user(6, 'c'), user(7, 'd'), drop(9, { fromSeq: 6, toSeq: 7 }), user(10, null)];
        expect(visibleUserLocalIds(log)).toEqual(['a', 'd']);
    });
});

describe('legacy split repair (startup, no pending record)', () => {
    // The incident: source has T1..T6; the copy keeps T1..T3 (rewind of T4 whose
    // ack was lost — the web never wrote the tombstone nor sent the edit).
    const source = ['t1', 't2', 't3', 't4', 't5', 't6'].flatMap((id, i) => [prompt(id, 'SRC', `p${i}`), reply(`r-${id}`, 'SRC')]);
    const copy = source.slice(0, 6);
    const visible = ['t1', 't2', 't3', 't4', 't5', 't6'];

    it('reads prompt uuids and the source id from a rewound copy', () => {
        const lineage = transcriptLineage(copy, 'COPY');
        expect(lineage.sourceClaudeSessionId).toBe('SRC');
        expect([...lineage.promptUuids]).toEqual(['t1', 't2', 't3']);
        expect(transcriptLineage(source, 'SRC').sourceClaudeSessionId).toBeNull();
    });

    it('switches back when visible prompts exist only in the source', () => {
        const repair = decideLineageRepair({
            visibleLocalIds: visible,
            current: transcriptLineage(copy, 'COPY'),
            source: { claudeSessionId: 'SRC', promptUuids: transcriptLineage(source, 'SRC').promptUuids },
        });
        expect(repair).toEqual({ kind: 'revert', to: 'SRC', missing: ['t4', 't5', 't6'], onlyInCurrent: [] });
    });

    it('leaves a confirmed rewind alone: the dropped prompts are not visible', () => {
        const confirmedCopy = [...copy, prompt('t7', 'COPY', 'edited')];
        expect(decideLineageRepair({
            visibleLocalIds: ['t1', 't2', 't3', 't7'],
            current: transcriptLineage(confirmedCopy, 'COPY'),
            source: { claudeSessionId: 'SRC', promptUuids: transcriptLineage(source, 'SRC').promptUuids },
        })).toEqual({ kind: 'none' });
    });

    it('ignores prompts without a uuid and original conversations', () => {
        const noUuidSource = [prompt(undefined, 'SRC', 'old'), ...source];
        expect(decideLineageRepair({
            visibleLocalIds: ['t1', 'web-local-without-uuid'],
            current: transcriptLineage(copy, 'COPY'),
            source: { claudeSessionId: 'SRC', promptUuids: transcriptLineage(noUuidSource, 'SRC').promptUuids },
        })).toEqual({ kind: 'none' });
        expect(decideLineageRepair({ visibleLocalIds: visible, current: transcriptLineage(copy, 'COPY'), source: null })).toEqual({ kind: 'none' });
    });

    it('reports prompts the agent got after the split (they are forgotten by the revert)', () => {
        const continued = [...copy, prompt('t9', 'COPY', 'later')];
        expect(decideLineageRepair({
            visibleLocalIds: [...visible, 't9'],
            current: transcriptLineage(continued, 'COPY'),
            source: { claudeSessionId: 'SRC', promptUuids: transcriptLineage(source, 'SRC').promptUuids },
        })).toMatchObject({ kind: 'revert', to: 'SRC', onlyInCurrent: ['t9'] });
    });
});
