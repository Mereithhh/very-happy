import { describe, expect, it, vi } from 'vitest';
import { registerAgentAttachmentDownloads } from './agentAttachments';

describe('agent attachment download registration', () => {
  it.each(['download', 'decrypt'])('reports %s failure and settles the tracked download', async (failure) => {
    const session = {
      onFileEvent: vi.fn(), trackAttachmentDownload: vi.fn(), sendSessionEvent: vi.fn(),
      downloadAndDecryptAttachment: failure === 'download' ? vi.fn().mockRejectedValue(new Error('network')) : vi.fn().mockResolvedValue(null),
    };
    registerAgentAttachmentDownloads(session);
    session.onFileEvent.mock.calls[0][0]({ content: { data: { ev: { name: 'a.png', ref: 'opaque' } } } });
    expect(await session.trackAttachmentDownload.mock.calls[0][0]).toBeNull();
    expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: expect.stringContaining('Could not download attachment: a.png') });
  });
});
