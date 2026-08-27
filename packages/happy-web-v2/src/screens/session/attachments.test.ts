import { describe, expect, it } from 'vitest';
import { isSupportedAttachment, MAX_ATTACHMENT_SOURCE_BYTES } from './useAttachments';

describe('composer attachments', () => {
    it.each([
        [{ type: 'image/png', name: 'capture' }, true],
        [{ type: 'image/webp', name: 'capture' }, true],
        [{ type: 'image/heic', name: 'photo.heic' }, false],
        [{ type: 'image/svg+xml', name: 'diagram.svg' }, false],
        [{ type: 'application/pdf', name: 'spec.bin' }, true],
        [{ type: '', name: 'SPEC.PDF' }, true],
        [{ type: 'text/plain', name: 'notes.txt' }, false],
    ])('classifies $0', (file, expected) => {
        expect(isSupportedAttachment(file)).toBe(expected);
    });

    it('leaves encryption overhead below the server 10MB ceiling', () => {
        expect(MAX_ATTACHMENT_SOURCE_BYTES).toBeLessThan(10 * 1024 * 1024);
    });
});
