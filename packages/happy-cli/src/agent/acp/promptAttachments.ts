import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { PendingAttachment } from '@/utils/MessageQueue2';
import { CLAUDE_ATTACHMENT_KINDS } from '@/claude/utils/attachmentContent';

const ACP_IMAGE_KINDS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

/**
 * What the composer may attach for this ACP agent (metadata.attachmentKinds).
 * pi: images natively plus any file through the staged manifest (B-472).
 * B-970b dsh: images only, and only when its initialize said
 * `promptCapabilities.image` (dsh decides by the session's model); dsh has no
 * embeddedContext, so files stay hidden. Others (gemini, opencode…): nothing.
 */
export function acpAttachmentKinds(agentName: string, supportsImages: boolean): string[] {
  if (!supportsImages) return [];
  if (agentName === 'pi') return [...CLAUDE_ATTACHMENT_KINDS];
  if (agentName === 'dsh') return [...ACP_IMAGE_KINDS];
  return [];
}

/** Images use ACP's native blocks; arbitrary files stay in the local manifest. */
export function acpImageBlocks(attachments: PendingAttachment[], supportsImages: boolean): ContentBlock[] {
  return attachments.filter((file) => ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimeType)).map((file) => {
    if (!supportsImages) throw new Error('This ACP agent does not support image prompts');
    return { type: 'image', data: Buffer.from(file.data).toString('base64'), mimeType: file.mimeType };
  });
}
