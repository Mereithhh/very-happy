/**
 * Shared types for attachment upload pipeline.
 * Defined here (not in hooks/) to avoid circular dependencies:
 * hooks/ imports from sync/, so sync/ cannot import from hooks/.
 */

export type AttachmentPreview = {
    /** Stable unique identifier for use as React key and for removal. */
    id: string;
    uri: string;
    width: number;
    height: number;
    mimeType: string;
    /** May be 0 if the system did not provide the file size. */
    size: number;
    name: string;
    thumbhash?: string;
};

/** Result of a successful attachment upload — ready to build a file event. */
export type UploadedAttachment = {
    ref: string;
    name: string;
    size: number;
    mimeType: string;
    width: number;
    height: number;
    thumbhash?: string;
};

/**
 * B-961b: an attachment already uploaded by an earlier send, carried by its
 * file event — edit/retry re-emits it verbatim (same `ref`), so the machine
 * never needs the user to pick the file again.
 */
export type ReusableAttachment = {
    ref: string;
    name: string;
    size: number;
    mimeType?: string;
    image?: { width: number; height: number; thumbhash?: string };
};
