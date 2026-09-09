/** Old Claude wrappers support images; other runners must advertise consumption. */
export function supportsSessionAttachments(metadata: {
    flavor?: string | null;
    attachmentKinds?: string[];
} | null | undefined): boolean {
    return !metadata?.flavor || metadata.flavor === 'claude' || (metadata.attachmentKinds?.length ?? 0) > 0;
}
