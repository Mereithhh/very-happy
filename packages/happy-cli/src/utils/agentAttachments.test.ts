import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAgentAttachmentDownloads } from './agentAttachments';
import { recordMachineAttachment } from './attachmentRegistry';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('agent attachment download registration', () => {
  it.each(['download', 'decrypt'])('reports %s failure and settles the tracked download', async (failure) => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'vh-attach-'));
    dirs.push(happyHomeDir);
    const session = {
      sessionId: 's1',
      onFileEvent: vi.fn(), trackAttachmentDownload: vi.fn(), sendSessionEvent: vi.fn(),
      downloadAndDecryptAttachment: failure === 'download' ? vi.fn().mockRejectedValue(new Error('network')) : vi.fn().mockResolvedValue(null),
    };
    registerAgentAttachmentDownloads(session, { happyHomeDir });
    session.onFileEvent.mock.calls[0][0]({ content: { data: { ev: { name: 'a.png', ref: 'opaque' } } } });
    expect(await session.trackAttachmentDownload.mock.calls[0][0]).toBeNull();
    expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: expect.stringContaining('Could not download attachment: a.png') });
  });

  it('reuses the staged copy for a ref this machine already holds (B-961b)', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'vh-attach-'));
    dirs.push(happyHomeDir);
    const stagedFile = join(happyHomeDir, 'reused.png');
    await writeFile(stagedFile, new Uint8Array([1, 2, 3]));
    await recordMachineAttachment(happyHomeDir, 's1', 'ref-1', {
      path: stagedFile, name: 'a.png', mimeType: 'image/png', size: 3,
    });
    const download = vi.fn();
    const session = {
      sessionId: 's1',
      onFileEvent: vi.fn(), trackAttachmentDownload: vi.fn(), sendSessionEvent: vi.fn(),
      downloadAndDecryptAttachment: download,
    };
    registerAgentAttachmentDownloads(session, { happyHomeDir });
    session.onFileEvent.mock.calls[0][0]({ content: { data: { ev: { name: 'a.png', ref: 'ref-1', mimeType: 'image/png' } } } });
    const resolved = await session.trackAttachmentDownload.mock.calls[0][0];
    expect(download).not.toHaveBeenCalled();
    expect(resolved).toMatchObject({ ref: 'ref-1', path: stagedFile, name: 'a.png', mimeType: 'image/png' });
  });
});
