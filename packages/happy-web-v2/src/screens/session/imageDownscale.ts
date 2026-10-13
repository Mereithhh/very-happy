/**
 * B-568 ③: oversized photos are redrawn on the client before they are attached.
 * A 4000px phone photo costs upload time and model context for nothing; the
 * long edge is capped at 2000px. (Idea from Orca's clipboard-image downscale,
 * MIT; this caps the edge instead of a byte budget.)
 *
 * Only still jpeg / png / webp (animated APNG/WebP are skipped): GIF would lose its animation, SVG has no pixels,
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

const ascii = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

/**
 * Animated PNG / WebP must not be redrawn: canvas keeps only the first frame.
 * APNG = an `acTL` chunk before the first `IDAT`; animated WebP = the VP8X
 * animation flag (0x02) or an `ANIM`/`ANMF` chunk. Unparseable → treated as
 * animated (the safe answer is "keep the original").
 */
export function isAnimatedImage(bytes: Uint8Array, mimeType: string): boolean {
    const type = mimeType.toLowerCase();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (type === 'image/png') {
        if (bytes.length < 8 || bytes[0] !== 0x89 || ascii(bytes, 1).slice(0, 3) !== 'PNG') return true;
        let at = 8;
        while (at + 8 <= bytes.length) {
            const length = view.getUint32(at);
            const chunk = ascii(bytes, at + 4);
            if (chunk === 'acTL') return true;
            if (chunk === 'IDAT' || chunk === 'IEND') return false;
            at += 12 + length;
        }
        return true;
    }
    if (type === 'image/webp') {
        if (bytes.length < 16 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WEBP') return true;
        let at = 12;
        while (at + 8 <= bytes.length) {
            const chunk = ascii(bytes, at);
            const length = view.getUint32(at + 4, true);
            if (chunk === 'VP8X' && at + 8 < bytes.length && (bytes[at + 8] & 0x02) !== 0) return true;
            if (chunk === 'ANIM' || chunk === 'ANMF') return true;
            at += 8 + length + (length % 2);
        }
        return false;
    }
    return false;
}

/** Browser-only: redraw `uri` at `target`; null on any failure or no gain. */
export async function redrawImage(
    uri: string,
    mimeType: string,
    originalSize: number,
    target: { width: number; height: number },
): Promise<Blob | null> {
    let canvas: HTMLCanvasElement | null = null;
    try {
        const img = new Image();
        img.decoding = 'async';
        img.src = uri;
        await img.decode();
        const surface = document.createElement('canvas');
        canvas = surface;
        surface.width = target.width;
        surface.height = target.height;
        const ctx = surface.getContext('2d');
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, target.width, target.height);
        const type = mimeType.toLowerCase();
        const blob = await new Promise<Blob | null>((resolve) =>
            surface.toBlob(resolve, type, type === 'image/png' ? undefined : IMAGE_LOSSY_QUALITY),
        );
        // toBlob falls back to PNG for an unsupported type — then the file
        // would lie about its own format; keep the original instead.
        if (!blob || blob.type !== type || blob.size >= originalSize) return null;
        return blob;
    } catch {
        return null;
    } finally {
        // Release the backing store now; iOS caps total canvas memory per page.
        if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
        }
    }
}
