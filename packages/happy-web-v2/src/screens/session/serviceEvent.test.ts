import { describe, expect, it } from 'vitest';
import { presentServiceEvent } from './serviceEvent';

describe('presentServiceEvent', () => {
    it('distinguishes a deliberate stop from a failure', () => {
        expect(presentServiceEvent('Aborted by user')).toEqual({ kind: 'stopped', textKey: 'session.chat.stoppedByYou' });
        expect(presentServiceEvent('Process exited unexpectedly')).toEqual({ kind: 'error', textKey: 'session.chat.processFailed' });
    });

    it('keeps unknown service notes intact', () => {
        expect(presentServiceEvent('Context was reset')).toEqual({ kind: 'subtle', text: 'Context was reset' });
    });
});
