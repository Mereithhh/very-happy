import { describe, expect, it } from 'vitest';
import { acpAttachmentKinds, acpImageBlocks } from './promptAttachments';
import { CLAUDE_ATTACHMENT_KINDS } from '@/claude/utils/attachmentContent';

describe('ACP attachment blocks', () => {
  const image = { data: new Uint8Array([0, 255, 42]), mimeType: 'image/png', name: 'photo.png' };
  it('encodes original image bytes in native image blocks', () => {
    expect(acpImageBlocks([image], true)).toEqual([{ type: 'image', data: 'AP8q', mimeType: 'image/png' }]);
  });
  it('fails explicitly if the agent did not negotiate image support', () => {
    expect(() => acpImageBlocks([image], false)).toThrow('does not support image');
  });
  it('leaves opaque files to the manifest without pretending they are images', () => {
    expect(acpImageBlocks([{ ...image, mimeType: 'application/pdf' }], false)).toEqual([]);
  });
});

describe('acpAttachmentKinds (B-970b)', () => {
  it('dsh offers images only, and only when its model takes images', () => {
    expect(acpAttachmentKinds('dsh', true)).toEqual(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
    expect(acpAttachmentKinds('dsh', false)).toEqual([]);
  });
  it('pi keeps images + PDF + any file; gemini and others stay without attachments', () => {
    expect(acpAttachmentKinds('pi', true)).toEqual([...CLAUDE_ATTACHMENT_KINDS]);
    expect(acpAttachmentKinds('pi', false)).toEqual([]);
    expect(acpAttachmentKinds('gemini', true)).toEqual([]);
    expect(acpAttachmentKinds('opencode', true)).toEqual([]);
  });
});
