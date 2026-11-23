import type { ApiSessionClient } from '@/api/apiSession';
import { resolveFileEventAttachment } from './attachmentReuse';

/**
 * B-961b: one `file` event → the bytes the next user message carries.
 *
 * When this machine already staged the same `ref` (a retry / edit re-sends an
 * attachment uploaded earlier), the staged path is reused instead of the blob
 * being fetched and written again.
 */
export function registerAgentAttachmentDownloads(
  session: Pick<ApiSessionClient,
    'onFileEvent' | 'downloadAndDecryptAttachment' | 'trackAttachmentDownload' | 'sendSessionEvent' | 'sessionId'>,
  options: { happyHomeDir: string },
): void {
  session.onFileEvent((fileEvent) => {
    const attachment = fileEvent.content.data.ev;
    const download = resolveFileEventAttachment({
      happyHomeDir: options.happyHomeDir,
      sessionId: session.sessionId,
      download: (ref) => session.downloadAndDecryptAttachment(ref),
    }, {
      ref: attachment.ref,
      name: attachment.name,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    }).then((resolved) => {
      if (resolved) return resolved;
      session.sendSessionEvent({ type: 'message', message: `Could not download attachment: ${attachment.name}. Please attach it again.` });
      return null;
    }).catch(() => {
      session.sendSessionEvent({ type: 'message', message: `Could not download attachment: ${attachment.name}. Please attach it again.` });
      return null;
    });
    session.trackAttachmentDownload(download);
  });
}
