import { describe, expect, it } from 'vitest';
import { isSupportedAttachment, MAX_ATTACHMENT_SOURCE_BYTES } from './useAttachments';

describe('composer attachments', () => {
    it.each([
        [{ type: 'image/png', name: 'capture' }, true],
        [{ type: 'image/webp', name: 'capture' }, true],
        [{ type: 'image/heic', name: 'photo.heic' }, true],
        [{ type: 'image/svg+xml', name: 'diagram.svg' }, true],
        [{ type: 'application/pdf', name: 'spec.bin' }, true],
        [{ type: '', name: 'SPEC.PDF' }, true],
        [{ type: 'text/plain', name: 'notes.txt' }, true],
        [{ type: '', name: 'archive.unknown' }, true],
    ])('classifies $0', (file, expected) => {
        expect(isSupportedAttachment(file)).toBe(expected);
    });

    it('caps the original file at exactly 50 MiB', () => {
        expect(MAX_ATTACHMENT_SOURCE_BYTES).toBe(50 * 1024 * 1024);
    });
});
