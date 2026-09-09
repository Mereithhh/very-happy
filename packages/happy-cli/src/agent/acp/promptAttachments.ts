import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { PendingAttachment } from '@/utils/MessageQueue2';

/** Images use ACP's native blocks; arbitrary files stay in the local manifest. */
export function acpImageBlocks(attachments: PendingAttachment[], supportsImages: boolean): ContentBlock[] {
  return attachments.filter((file) => ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimeType)).map((file) => {
    if (!supportsImages) throw new Error('This ACP agent does not support image prompts');
    return { type: 'image', data: Buffer.from(file.data).toString('base64'), mimeType: file.mimeType };
  });
}
