import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { buildChatRows } from './chatTurns';
import { dropSlashCommandEchoes } from './compaction';

const user = (id: string, createdAt: number, text: string, localId: string | null = null): Message => ({
    kind: 'user-text', id, localId, createdAt, text,
});
const event = (id: string, createdAt: number, message: string): Message => ({
    kind: 'agent-event', id, createdAt, event: { type: 'message', message },
} as Message);
const ECHO = '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>';
const STDOUT = '<local-command-stdout>Compacted </local-command-stdout>';

// Shape of a real 2026-10-07 dev-sg `/compact` (wrapper log + transcript): the
// SDK replays the command and its stdout at the END, after the summary.
const compactTurn: Message[] = [
    user('typed', 1_000, '/compact', 'local-1'),
    event('started', 1_500, 'Compaction started'),
    user('echo', 101_400, ECHO),
    user('stdout', 101_408, STDOUT),
    event('done', 101_500, 'Compaction completed'),
];
const rowsOf = (messages: Message[], live: boolean) => buildChatRows(dropSlashCommandEchoes(messages), live);

describe('B-540 /compact renders as one boundary line', () => {
    it('collapses the turn: the typed bubble, then one compaction row — no echo bubble, no 「耗时」 activity', () => {
        const rows = rowsOf(compactTurn, false);
        expect(rows.map((row) => row.type)).toEqual(['message', 'compaction']);
        expect(rows[0]).toMatchObject({ message: { id: 'typed' } });
        expect(rows[1]).toMatchObject({ state: 'done', startedAt: 1_500, durationSeconds: 100 });
    });

    it('is running while live and not yet completed, interrupted once the session stopped without an end', () => {
        const open = compactTurn.slice(0, 2);
        expect(rowsOf(open, true)[1]).toMatchObject({ type: 'compaction', state: 'running', startedAt: 1_500 });
        expect(rowsOf(open, false)[1]).toMatchObject({ type: 'compaction', state: 'interrupted' });
    });

    it('carries the failure reason', () => {
        const rows = rowsOf([compactTurn[0], compactTurn[1], event('fail', 9_000, 'Compaction failed: prompt too long')], false);
        expect(rows[1]).toMatchObject({ type: 'compaction', state: 'failed', error: 'prompt too long', durationSeconds: 8 });
    });

    it('keeps the ordinary rendering when anything else happened in the turn', () => {
        const rows = rowsOf([compactTurn[0], compactTurn[1], event('stop', 5_000, 'Aborted by user')], false);
        expect(rows.some((row) => row.type === 'compaction')).toBe(false);
    });
});

describe('dropSlashCommandEchoes', () => {
    it('keeps a command run from the terminal (no typed twin) and its stdout', () => {
        const messages = [user('echo', 1, ECHO), user('stdout', 2, STDOUT)];
        expect(dropSlashCommandEchoes(messages)).toBe(messages);
    });
    it('only drops the replay of the same command', () => {
        const other = user('echo', 2, '<command-name>/context</command-name><command-args></command-args>');
        expect(dropSlashCommandEchoes([user('typed', 1, '/compact'), other]).map((m) => m.id)).toEqual(['typed', 'echo']);
        const withArgs = user('echo', 2, '<command-name>/compact</command-name><command-args>keep the plan</command-args>');
        expect(dropSlashCommandEchoes([user('typed', 1, '/compact  keep the plan'), withArgs]).map((m) => m.id)).toEqual(['typed']);
    });
    it('never drops ordinary user text', () => {
        const messages = [user('typed', 1, '/compact'), user('next', 2, 'thanks')];
        expect(dropSlashCommandEchoes(messages)).toBe(messages);
    });
});
