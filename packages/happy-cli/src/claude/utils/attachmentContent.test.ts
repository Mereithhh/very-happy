import { describe, expect, it } from 'vitest';
import { attachmentToClaudeContentBlock } from './attachmentContent';

describe('attachmentToClaudeContentBlock', () => {
    it.each([
        ['png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png'],
        ['jpeg', new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg'],
        ['gif', new Uint8Array([0x47, 0x49, 0x46, 0x38]), 'image/gif'],
        ['webp', new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), 'image/webp'],
    ])('maps %s magic bytes to an image block', (_name, bytes, mediaType) => {
        expect(attachmentToClaudeContentBlock(bytes)).toMatchObject({
            type: 'image',
            source: { type: 'base64', media_type: mediaType },
        });
    });

    it('maps PDF magic bytes to a document block', () => {
        expect(attachmentToClaudeContentBlock(new TextEncoder().encode('%PDF-1.7'))).toMatchObject({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf' },
        });
    });

    it('rejects an unsupported payload regardless of its claimed filename or MIME', () => {
        expect(attachmentToClaudeContentBlock(new TextEncoder().encode('plain text'))).toBeNull();
    });
});
