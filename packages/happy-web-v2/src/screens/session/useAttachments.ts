import { useCallback, useState } from 'react';
import type { AttachmentPreview } from '@/sync/attachmentTypes';
import { generateThumbhash } from '@/utils/thumbhash';

let attachmentSeq = 0;

/**
 * Extract image File objects from a paste ClipboardEvent. (Inlined here rather
 * than importing @/utils/pasteImages, which ships only a .web variant that the
 * type-checker can't resolve; the logic is trivial.)
 */
export function getImagesFromClipboard(event: ClipboardEvent): File[] {
    const items = event.clipboardData?.items;
    if (!items) return [];
    const images: File[] = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file' && item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) images.push(file);
        }
    }
    return images;
}

/** Extract image File objects from a drag-and-drop DragEvent. */
export function getImagesFromDrop(event: DragEvent): File[] {
    const files = event.dataTransfer?.files;
    if (!files) return [];
    const images: File[] = [];
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.type.startsWith('image/')) images.push(file);
    }
    return images;
}

async function fileToPreview(file: File): Promise<AttachmentPreview | null> {
    try {
        const uri = URL.createObjectURL(file);
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
        return null;
    }
}

/**
 * Composer image-attachment state. Converts picked/pasted/dropped image Files
 * into AttachmentPreview items (object-URL preview + thumbhash) ready to pass
 * to sync.sendMessage({ attachments }).
 */
export function useAttachments() {
    const [attachments, setAttachments] = useState<AttachmentPreview[]>([]);

    const addFiles = useCallback(async (files: File[]) => {
        const images = files.filter((f) => f.type.startsWith('image/'));
        if (images.length === 0) return;
        const previews = await Promise.all(images.map(fileToPreview));
        const valid = previews.filter((p): p is AttachmentPreview => p !== null);
        if (valid.length) setAttachments((prev) => [...prev, ...valid]);
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
                }
            }
            return [];
        });
    }, []);

    return { attachments, addFiles, remove, clear };
}
