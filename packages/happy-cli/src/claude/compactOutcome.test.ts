import { describe, expect, it } from 'vitest';
import { compactOutcomeEvent, readCompactStatus } from './compactOutcome';

describe('Claude /compact outcome (QA21)', () => {
    it('reads the verdict Claude Code puts on its status frame', () => {
        expect(readCompactStatus({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'Not enough messages to compact.' }))
            .toEqual({ result: 'failed', error: 'Not enough messages to compact.' });
        expect(readCompactStatus({ type: 'system', subtype: 'status', status: null, compact_result: 'success' })).toEqual({ result: 'success' });
        expect(readCompactStatus({ type: 'system', subtype: 'status', status: 'compacting' })).toBeNull();
        expect(readCompactStatus({ type: 'system', subtype: 'init', compact_result: 'success' })).toBeNull();
        expect(readCompactStatus(null)).toBeNull();
    });

    it('a refused compaction ends in result/success but is reported as not compacted, with the reason', () => {
        expect(compactOutcomeEvent({ subtype: 'success' }, { result: 'failed', error: 'Not enough messages to compact.' }))
            .toBe('Compaction failed: Not enough messages to compact.');
        expect(compactOutcomeEvent({ subtype: 'success' }, { result: 'failed' })).toBe('Compaction failed: failed');
    });

    it('completed only when the compaction itself succeeded (or the CLI gives no verdict)', () => {
        expect(compactOutcomeEvent({ subtype: 'success' }, { result: 'success' })).toBe('Compaction completed');
        expect(compactOutcomeEvent({ subtype: 'success' }, null)).toBe('Compaction completed');
    });

    it('a failed turn keeps its own errors', () => {
        expect(compactOutcomeEvent({ subtype: 'error_during_execution', errors: ['boom'] }, { result: 'success' })).toBe('Compaction failed: boom');
        expect(compactOutcomeEvent({ subtype: 'error_max_turns' }, null)).toBe('Compaction failed: error_max_turns');
    });
});
