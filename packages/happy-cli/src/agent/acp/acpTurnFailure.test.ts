import { describe, expect, it } from 'vitest';
import { describeAcpTurnFailure } from './acpTurnFailure';

describe('describeAcpTurnFailure (B-629)', () => {
    it('a dead agent: the process line the web styles as a failure, and a restart', () => {
        const exit = Object.assign(new Error('pi process exited (code=137, signal=null): FATAL ERROR: heap limit'), { agentExited: true, agentExitCode: 137, agentExitSignal: null, agentStderrTail: 'FATAL ERROR: heap limit' });
        expect(describeAcpTurnFailure('pi', exit)).toEqual({ message: 'Process exited unexpectedly: pi process exited (code=137, signal=null): FATAL ERROR: heap limit', exited: true });
    });

    it('a JSON-RPC refusal: the agent\'s message and details, one line, bounded', () => {
        expect(describeAcpTurnFailure('pi', { code: -32000, message: 'Authentication required', data: { details: 'OPENAI_API_KEY missing' } }))
            .toEqual({ message: 'pi error: Authentication required: OPENAI_API_KEY missing', exited: false });
        expect(describeAcpTurnFailure('pi', { code: -32603, message: 'Internal error', data: { details: 'Internal error' } }).message).toBe('pi error: Internal error');
        const long = describeAcpTurnFailure('gemini', new Error(`boom\n${'y'.repeat(600)}`)).message;
        expect(long.startsWith('gemini error: boom y')).toBe(true);
        expect(long.length).toBeLessThanOrEqual('gemini error: '.length + 400);
    });

    it('anything else is still a line, never a crash', () => {
        expect(describeAcpTurnFailure('pi', 'nope')).toEqual({ message: 'pi error: nope', exited: false });
        expect(describeAcpTurnFailure('pi', { weird: true }).message).toBe('pi error: {"weird":true}');
    });
});
