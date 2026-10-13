/**
 * B-568 ③: oversized photos are redrawn on the client before they are attached.
 * A 4000px phone photo costs upload time and model context for nothing; the
 * long edge is capped at 2000px. (Idea from Orca's clipboard-image downscale,
 * MIT; this caps the edge instead of a byte budget.)
 *
 * Only jpeg / png / webp: GIF would lose its animation, SVG has no pixels,
 * HEIC is not decodable by most browsers. The format is kept — PNG stays PNG so
 * transparency survives. Any failure, or a result that is not smaller, keeps
 * the original file.
 */
export const IMAGE_MAX_EDGE = 2000;
export const IMAGE_LOSSY_QUALITY = 0.85;

const DOWNSCALABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function shouldDownscaleImage(mimeType: string): boolean {
    return DOWNSCALABLE.has(mimeType.toLowerCase());
}

/** Target pixel size, or null when the image already fits / dimensions are unusable. */
export function computeImageDownscale(
    width: number,
    height: number,
    maxEdge: number = IMAGE_MAX_EDGE,
): { width: number; height: number } | null {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    const longEdge = Math.max(width, height);
    if (longEdge <= maxEdge) return null;
    const scale = maxEdge / longEdge;
    return {
        width: width >= height ? maxEdge : Math.max(1, Math.round(width * scale)),
        height: height > width ? maxEdge : Math.max(1, Math.round(height * scale)),
    };
}

/** Browser-only: redraw `uri` at `target`; null on any failure or no gain. */
export async function redrawImage(
    uri: string,
    mimeType: string,
    originalSize: number,
    target: { width: number; height: number },
): Promise<Blob | null> {
    try {
        const img = new Image();
        img.decoding = 'async';
        img.src = uri;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = target.width;
        canvas.height = target.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, target.width, target.height);
        const type = mimeType.toLowerCase();
        const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, type, type === 'image/png' ? undefined : IMAGE_LOSSY_QUALITY),
        );
        // toBlob falls back to PNG for an unsupported type — then the file
        // would lie about its own format; keep the original instead.
        if (!blob || blob.type !== type || blob.size >= originalSize) return null;
        return blob;
    } catch {
        return null;
    }
}
