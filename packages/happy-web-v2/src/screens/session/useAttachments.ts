import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { generateThumbhash } from '@/utils/thumbhash';

let attachmentSeq = 0;

/**
 * Extract File objects from a paste ClipboardEvent. (Inlined here rather
 * than importing @/utils/pasteImages, which ships only a .web variant that the
 * type-checker can't resolve; the logic is trivial.)
 */
export function getFilesFromClipboard(event: ClipboardEvent): File[] {
    const items = event.clipboardData?.items;
    if (!items) return [];
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) files.push(file);
        }
    }
    return files;
}

/** Extract File objects from a drag-and-drop DragEvent. */
export function getFilesFromDrop(event: DragEvent): File[] {
    const files = event.dataTransfer?.files;
    if (!files) return [];
    const result: File[] = [];
    for (let i = 0; i < files.length; i++) {
        result.push(files[i]);
    }
    return result;
}

export const MAX_ATTACHMENT_SOURCE_BYTES = 10 * 1024 * 1024 - 64;
export const SUPPORTED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

export function isSupportedAttachment(file: Pick<File, 'type' | 'name'>): boolean {
    const type = file.type.toLowerCase();
    const name = file.name.toLowerCase();
    return SUPPORTED_IMAGE_MIME_TYPES.includes(type as typeof SUPPORTED_IMAGE_MIME_TYPES[number])
        || type === 'application/pdf'
        || name.endsWith('.pdf');
}

export function isPdfAttachment(file: Pick<File, 'type' | 'name'>): boolean {
    return file.type.toLowerCase() === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

export type AddAttachmentResult = {
    added: number;
    unsupported: File[];
    tooLarge: File[];
};

async function fileToPreview(
    file: File,
    ownUrl: (uri: string) => void,
    disownUrl: (uri: string) => void,
): Promise<AttachmentPreview | null> {
    const uri = URL.createObjectURL(file);
    ownUrl(uri);
    try {
        const isPdf = isPdfAttachment(file);
        if (isPdf) {
            return {
                id: `att-${attachmentSeq++}-${Date.now()}`,
                uri,
                width: 0,
                height: 0,
                size: file.size,
                name: file.name || `document_${Date.now()}.pdf`,
                mimeType: 'application/pdf',
            };
        }
        const { width, height } = await new Promise<{ width: number; height: number }>((resolve, reject) => {
            const img = new Image();
            const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
            img.onload = () => {
                clearTimeout(timeout);
                resolve({ width: img.naturalWidth, height: img.naturalHeight });
            };
            img.onerror = () => {
                clearTimeout(timeout);
                reject(new Error('load error'));
            };
            img.src = uri;
        });
        const thumbhash = width > 0 && height > 0 ? await generateThumbhash(uri, width, height) : undefined;
        return {
            id: `att-${attachmentSeq++}-${Date.now()}`,
            uri,
            width,
            height,
            size: file.size,
            name: file.name || `paste_${Date.now()}.png`,
            mimeType: file.type || 'image/png',
            thumbhash,
        };
    } catch {
        URL.revokeObjectURL(uri);
        disownUrl(uri);
        return null;
    }
}

/**
 * Composer attachment state. Converts picked/pasted/dropped images and PDFs
 * into AttachmentPreview items ready for sync.sendMessage({ attachments }).
 */
export function useAttachments() {
    const [attachments, setAttachments] = useState<AttachmentPreview[]>([]);
    const [processing, setProcessing] = useState(false);
    const ownedUrlsRef = useRef(new Set<string>());
    const processingCountRef = useRef(0);
    const mountedRef = useRef(true);

    useEffect(() => {
        // React StrictMode deliberately runs setup → cleanup → setup in dev.
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            for (const uri of ownedUrlsRef.current) {
                URL.revokeObjectURL(uri);
            }
            ownedUrlsRef.current.clear();
        };
    }, []);

    const addFiles = useCallback(async (files: File[]): Promise<AddAttachmentResult> => {
        const unsupported = files.filter((file) => !isSupportedAttachment(file));
        const tooLarge = files.filter((file) => isSupportedAttachment(file) && file.size > MAX_ATTACHMENT_SOURCE_BYTES);
        const accepted = files.filter((file) => isSupportedAttachment(file) && file.size <= MAX_ATTACHMENT_SOURCE_BYTES);
        if (accepted.length === 0) return { added: 0, unsupported, tooLarge };
        processingCountRef.current++;
        setProcessing(true);
        try {
            const previews = await Promise.all(accepted.map((file) => fileToPreview(
                file,
                (uri) => ownedUrlsRef.current.add(uri),
                (uri) => ownedUrlsRef.current.delete(uri),
            )));
            const valid = previews.filter((p): p is AttachmentPreview => p !== null);
            if (!mountedRef.current) {
                for (const preview of valid) URL.revokeObjectURL(preview.uri);
                return { added: 0, unsupported, tooLarge };
            }
            if (valid.length) setAttachments((prev) => [...prev, ...valid]);
            return { added: valid.length, unsupported, tooLarge };
        } finally {
            processingCountRef.current--;
            if (processingCountRef.current === 0 && mountedRef.current) setProcessing(false);
        }
    }, []);

    const remove = useCallback((id: string) => {
        setAttachments((prev) => {
            const target = prev.find((a) => a.id === id);
            if (target?.uri?.startsWith('blob:')) {
                try {
                    URL.revokeObjectURL(target.uri);
                } catch {
                    /* ignore */
                }
                ownedUrlsRef.current.delete(target.uri);
            }
            return prev.filter((a) => a.id !== id);
        });
    }, []);

    const clear = useCallback(() => {
        setAttachments((prev) => {
            for (const a of prev) {
                if (a.uri?.startsWith('blob:')) {
                    try {
                        URL.revokeObjectURL(a.uri);
                    } catch {
                        /* ignore */
                    }
                    ownedUrlsRef.current.delete(a.uri);
                }
            }
            return [];
        });
    }, []);

    // Transfer ownership to the queued-message buffer without revoking Blob
    // URLs. The queue releases them after send/delete; clear() remains the
    // destructive composer-only operation.
    const take = useCallback(() => {
        const current = attachments;
        for (const attachment of current) ownedUrlsRef.current.delete(attachment.uri);
        setAttachments([]);
        return current;
    }, [attachments]);

    const restore = useCallback((items: AttachmentPreview[]) => {
        if (items.length === 0) return;
        if (!mountedRef.current) {
            for (const attachment of items) URL.revokeObjectURL(attachment.uri);
            return;
        }
        for (const attachment of items) ownedUrlsRef.current.add(attachment.uri);
        setAttachments((current) => [...items, ...current]);
    }, []);

    return { attachments, processing, addFiles, remove, clear, take, restore };
}
