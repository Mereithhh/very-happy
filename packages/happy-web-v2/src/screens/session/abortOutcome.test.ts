import { describe, expect, it } from 'vitest';
import { abortOutcomeForError } from './abortOutcome';

describe('abortOutcomeForError (B-320)', () => {
    it('reports a relay timeout as still-settling, never as failure', () => {
        // `doAbort` awaits the whole SDK query unwinding while the relay caps a
        // session RPC at 30s. Calling that "failed" makes the UI contradict the
        // "Aborted by user" line that lands seconds later.
        expect(abortOutcomeForError(new Error('operation has timed out'))).toBe('timeout');
        expect(abortOutcomeForError(new Error('RPC timed out'))).toBe('timeout');
    });

    it('reports a 铁律-17 error envelope as a real failure', () => {
        // RpcHandlerManager answers a thrown handler with `{ error }` under a
        // normal ack; ops.ts rethrows it as a plain Error with that text.
        expect(abortOutcomeForError(new Error('Method not found'))).toBe('failed');
        expect(abortOutcomeForError(undefined)).toBe('failed');
    });
});
