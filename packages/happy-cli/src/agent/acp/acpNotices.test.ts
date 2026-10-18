import { describe, expect, it } from 'vitest';
import { acpNoticeMessage, classifyPiAcpNotice } from './acpNotices';

describe('classifyPiAcpNotice (B-629)', () => {
    it('recognizes pi-acp 0.0.33 sentinel lines whole', () => {
        expect(classifyPiAcpNotice('Retrying (attempt 2/3, waiting 4s)...')).toEqual({ kind: 'retry', text: 'Retrying (attempt 2/3, waiting 4s)...' });
        expect(classifyPiAcpNotice('Retrying...')).toEqual({ kind: 'retry', text: 'Retrying...' });
        expect(classifyPiAcpNotice('Retry finished, resuming.')?.kind).toBe('retry-end');
        expect(classifyPiAcpNotice('Context nearing limit, running automatic compaction...')?.kind).toBe('compaction');
        expect(classifyPiAcpNotice('Automatic compaction finished; context was summarized to continue the session.')?.kind).toBe('compaction-end');
        expect(classifyPiAcpNotice('Pi editor UI request is not supported in ACP yet; cancelling it.')?.kind).toBe('unsupported');
    });

    it('takes a notify from its _meta, with its level', () => {
        expect(classifyPiAcpNotice('Build finished', { piAcp: { notify: { level: 'warning' } } })).toEqual({ kind: 'notify', text: 'Build finished', level: 'warning' });
    });

    it('leaves the model\'s own words alone, even when they mention retrying', () => {
        expect(classifyPiAcpNotice('I am retrying the build with a fix.')).toBeNull();
        expect(classifyPiAcpNotice('Retrying (attempt 2/3, waiting 4s)... and then I found the bug')).toBeNull();
        expect(classifyPiAcpNotice('')).toBeNull();
    });

    it('phrases the service line as the wrapper speaking', () => {
        expect(acpNoticeMessage('pi', { kind: 'retry', text: 'Retrying (attempt 1/3, waiting 2s)...' })).toBe('pi is retrying the model request (attempt 1/3, waiting 2s)');
        expect(acpNoticeMessage('pi', { kind: 'retry', text: 'Retrying...' })).toBe('pi is retrying the model request');
        expect(acpNoticeMessage('pi', { kind: 'notify', text: 'Tests passed', level: 'info' })).toBe('pi: Tests passed');
        expect(acpNoticeMessage('pi', { kind: 'notify', text: 'Disk full', level: 'error' })).toBe('pi error: Disk full');
    });
});
