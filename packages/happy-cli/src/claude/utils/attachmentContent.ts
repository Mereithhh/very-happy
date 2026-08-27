import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

type ClaudeImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export const CLAUDE_ATTACHMENT_KINDS = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
] as const;

function detectClaudeImageMime(bytes: Uint8Array): ClaudeImageMime | null {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return 'image/jpeg';
    }
    if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return 'image/gif';
    }
    if (
        bytes.length >= 12
        && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
        return 'image/webp';
    }
    return null;
}

function isPdf(bytes: Uint8Array): boolean {
    return bytes.length >= 5
        && bytes[0] === 0x25
        && bytes[1] === 0x50
        && bytes[2] === 0x44
        && bytes[3] === 0x46
        && bytes[4] === 0x2D;
}

/** Convert decrypted bytes to one of the attachment blocks Claude accepts. */
export function attachmentToClaudeContentBlock(bytes: Uint8Array): ContentBlockParam | null {
    const data = Buffer.from(bytes).toString('base64');
    const imageMime = detectClaudeImageMime(bytes);
    if (imageMime) {
        return {
            type: 'image',
            source: { type: 'base64', media_type: imageMime, data },
        };
    }
    if (isPdf(bytes)) {
        return {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data },
        };
    }
    return null;
}
