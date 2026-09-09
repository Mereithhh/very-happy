import { describe, expect, it } from 'vitest';
import { supportsSessionAttachments } from './attachmentCapabilities';

describe('attachment capability compatibility', () => {
    it('retains legacy Claude image support', () => {
        expect(supportsSessionAttachments(undefined)).toBe(true);
        expect(supportsSessionAttachments({ flavor: 'claude' })).toBe(true);
    });
    it.each(['codex', 'acp', 'pi', 'gemini', 'openclaw'])('requires %s wrapper capability, not the machine version', (flavor) => {
        expect(supportsSessionAttachments({ flavor })).toBe(false);
        expect(supportsSessionAttachments({ flavor, attachmentKinds: [] })).toBe(false);
        expect(supportsSessionAttachments({ flavor, attachmentKinds: ['image/png', '*/*'] })).toBe(true);
    });
});
