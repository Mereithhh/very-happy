/** Old Claude wrappers support images; other runners must advertise consumption. */
export function supportsSessionAttachments(metadata: {
    flavor?: string | null;
    attachmentKinds?: string[];
} | null | undefined): boolean {
    return !metadata?.flavor || metadata.flavor === 'claude' || (metadata.attachmentKinds?.length ?? 0) > 0;
}

const IMAGE_KINDS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * B-929: what a pending page (no session yet, so no metadata) may attach for
 * the chosen agent. Claude and Codex wrappers advertise images + PDF + any file
 * (Codex since its wrapper publishes `attachmentKinds`; an older one is caught
 * at delivery by `sessionAcceptsAttachments` and the files go back to the
 * composer). Other runners only know after they start (Pi depends on its
 * backend), so they get nothing here and the composer says why.
 */
export function pendingAttachmentKinds(agent: string | null | undefined): string[] {
    return agent === 'claude' || agent === 'codex' || !agent ? [...IMAGE_KINDS, 'application/pdf', '*/*'] : [];
}

/** May this file go to a target that advertises `kinds` (an old Claude wrapper = images only)? */
export function attachmentKindAllowed(kinds: readonly string[], file: { mimeType: string; name: string }): boolean {
    if (kinds.includes('*/*')) return true;
    const type = file.mimeType.toLowerCase();
    if (IMAGE_KINDS.includes(type)) return true;
    return kinds.includes('application/pdf') && (type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
}

/** B-929: the real session (once a pending one lands) takes every one of these files. */
export function sessionAcceptsAttachments(
    metadata: { flavor?: string | null; attachmentKinds?: string[] } | null | undefined,
    files: ReadonlyArray<{ mimeType: string; name: string }>,
): boolean {
    if (files.length === 0) return true;
    if (!supportsSessionAttachments(metadata)) return false;
    const kinds = metadata?.attachmentKinds ?? [];
    return files.every((file) => attachmentKindAllowed(kinds, file));
}

/**
 * B-929: a send that must carry ALL its files or nothing (a pending session's
 * first message). `unsupported`: the session takes no such files; `upload-failed`:
 * at least one upload failed; `lost`: the files did not survive (reload without
 * a stored copy). Nothing was queued when this is thrown.
 */
export class AttachmentSendError extends Error {
    constructor(readonly kind: 'unsupported' | 'upload-failed' | 'lost') {
        super(`attachments not sent: ${kind}`);
        this.name = 'AttachmentSendError';
    }
}
