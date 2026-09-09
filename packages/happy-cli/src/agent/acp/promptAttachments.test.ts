import { describe, expect, it } from 'vitest';
import { acpImageBlocks } from './promptAttachments';

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
