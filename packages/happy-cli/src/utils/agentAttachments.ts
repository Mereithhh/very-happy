import type { ApiSessionClient } from '@/api/apiSession';

/** Start downloads before the following user message atomically claims them. */
export function registerAgentAttachmentDownloads(session: Pick<ApiSessionClient,
  'onFileEvent' | 'downloadAndDecryptAttachment' | 'trackAttachmentDownload' | 'sendSessionEvent'>): void {
  session.onFileEvent((fileEvent) => {
    const attachment = fileEvent.content.data.ev;
    const download = (async () => {
      try {
        const data = await session.downloadAndDecryptAttachment(attachment.ref);
        if (!data) throw new Error('Attachment decryption failed');
        return { data, mimeType: attachment.mimeType ?? 'image/jpeg', name: attachment.name };
      } catch {
        session.sendSessionEvent({ type: 'message', message: `Could not download attachment: ${attachment.name}. Please attach it again.` });
        return null;
      }
    })();
    session.trackAttachmentDownload(download);
  });
}
