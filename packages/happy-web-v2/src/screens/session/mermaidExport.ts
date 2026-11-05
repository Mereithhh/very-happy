/**
 * B-890: turn the SVG mermaid rendered into the chat into files — the full-screen
 * viewer's image, the SVG download and the PNG download all come from here.
 *
 * mermaid's root is sized for the transcript (`width="100%"` + `max-width` style)
 * and has no background (the chat's `--bg-1` card is behind it). Standing alone
 * — in an `<img>`, an image viewer, a canvas — it needs an intrinsic size or it
 * renders at 0/300×150, and it needs its background or the theme's text colour
 * lands on whatever the viewer paints (light-on-white in the dark theme). So the
 * export bakes the CURRENT theme's `--bg-1` in as an opaque rect rather than
 * shipping a transparent file: the colours inside are the theme's too.
 *
 * Canvas safety: mermaid 11 ignores `flowchart.htmlLabels:false` (mermaidRender.ts)
 * and draws node labels as HTML inside `<foreignObject>`. Such an SVG loaded from a
 * **blob:** URL taints the canvas — measured in Chromium and WebKit, toBlob throws
 * SecurityError — while the same bytes from a **data:** URL do not (both engines),
 * so the PNG path rasterises a data: URL. img-src allows data: (securityHeaders.ts).
 * If an engine still refuses, `svgToPngBlob` rejects and the caller reports it.
 *
 * Fonts: mermaid sizes every label box with the page font (IBM Plex Sans), but an
 * SVG standing alone — `<img>`, canvas, the user's image viewer — cannot reach the
 * page's web fonts and falls back to a wider system font, so labels were clipped
 * ("Serve", "Run ager" — measured). The export embeds Plex Sans latin 400 (the
 * same 22 kB woff2 the app already ships) as a data: @font-face, and lets
 * foreignObject overflow as a backstop for glyphs outside that subset.
 */
import plexSansLatin400 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2?url';

export const MERMAID_FILE_BASENAME = 'mermaid-diagram';

/** Longest canvas side every current engine accepts (Safari caps area at 16.7 Mpx). */
const MAX_CANVAS_SIDE = 8192;
const MAX_CANVAS_AREA = 16_777_216;

export type StandaloneSvg = { svg: string; width: number; height: number };

function parseViewBox(value: string | null): { x: number; y: number; width: number; height: number } | null {
    if (!value) return null;
    const parts = value.trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const [x, y, width, height] = parts;
    return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** Remove one declaration from an inline style string, keeping the rest. */
function dropStyleProperty(style: string, property: string): string {
    return style
        .split(';')
        .map((decl) => decl.trim())
        .filter((decl) => decl && decl.split(':')[0].trim().toLowerCase() !== property)
        .join('; ');
}

/**
 * The rendered diagram as a self-contained SVG document: intrinsic width/height
 * from its viewBox, no transcript-only `max-width`, the theme background baked in.
 * Returns null for markup that is not an SVG with a usable viewBox.
 */
export function standaloneSvg(svgMarkup: string, background: string, fontFaceCss: string | null = null): StandaloneSvg | null {
    // The HTML parser, not 'image/svg+xml': it is how the transcript inserts this
    // same string (innerHTML), so whatever renders there parses here — mermaid's
    // output is not guaranteed to be well-formed XML. It is inert (no scripts run),
    // and XMLSerializer then writes a well-formed, namespaced SVG document.
    const doc = new DOMParser().parseFromString(svgMarkup, 'text/html');
    const root = doc.body.firstElementChild;
    if (!root || root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg') return null;
    const box = parseViewBox(root.getAttribute('viewBox'));
    if (!box) return null;
    const width = Math.ceil(box.width);
    const height = Math.ceil(box.height);
    root.setAttribute('width', String(width));
    root.setAttribute('height', String(height));
    const rootStyle = dropStyleProperty(root.getAttribute('style') ?? '', 'max-width');
    if (rootStyle) root.setAttribute('style', rootStyle);
    else root.removeAttribute('style');
    if (background) {
        // Bleeds a viewBox past every edge: the rounded-up width/height letterbox the
        // viewBox by a fraction of a pixel (preserveAspectRatio "meet"), and a rect of
        // exactly the viewBox left those edge pixels part-transparent (measured: corner
        // alpha 198/255 in the PNG). The root <svg> clips the overflow.
        const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(box.x - box.width));
        rect.setAttribute('y', String(box.y - box.height));
        rect.setAttribute('width', String(box.width * 3));
        rect.setAttribute('height', String(box.height * 3));
        rect.setAttribute('fill', background);
        root.insertBefore(rect, root.firstChild);
    }
    const style = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `${fontFaceCss ?? ''}foreignObject{overflow:visible}`;
    root.insertBefore(style, root.firstChild);
    return { svg: new XMLSerializer().serializeToString(root), width, height };
}

/**
 * PNG pixel ratio: the screen's (crisp on a retina display) but never below 2×,
 * then shrunk until the canvas fits every engine's size limits.
 */
export function pngScale(width: number, height: number, devicePixelRatio: number): number {
    let scale = Math.max(2, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1);
    scale = Math.min(scale, MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / height, Math.sqrt(MAX_CANVAS_AREA / (width * height)));
    return Math.max(0.01, scale);
}

/** The current theme's diagram card colour (`--bg-1`), resolved to a literal for the file. */
export function diagramBackground(): string {
    if (typeof document === 'undefined') return '';
    return getComputedStyle(document.documentElement).getPropertyValue('--bg-1').trim();
}

let fontCssPromise: Promise<string | null> | null = null;

/** The embedded @font-face (see the header); null if the font cannot be fetched — the export still works, wider. */
export function exportFontCss(): Promise<string | null> {
    fontCssPromise ??= fetch(plexSansLatin400)
        .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(`font ${response.status}`))))
        .then((blob) => new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).replace(/^data:[^;,]*/, 'data:font/woff2'));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        }))
        .then((dataUrl) => `@font-face{font-family:'IBM Plex Sans';font-style:normal;font-weight:400;src:url(${dataUrl}) format('woff2')}`)
        .catch((error) => {
            console.error('[mermaid] export font unavailable', error);
            fontCssPromise = null;
            return null;
        });
    return fontCssPromise;
}

export function svgBlob(svg: string): Blob {
    return new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
}

/** Rasterise a standalone SVG. Rejects if the image fails to load or the canvas is tainted. */
export async function svgToPngBlob(source: StandaloneSvg, devicePixelRatio: number): Promise<Blob> {
    const scale = pngScale(source.width, source.height, devicePixelRatio);
    // data:, not blob: — see the header (a blob: SVG with <foreignObject> taints the canvas).
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source.svg)}`;
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('mermaid-png-load'));
        image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('mermaid-png-context');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    // toBlob throws SecurityError synchronously on a tainted canvas.
    return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('mermaid-png-encode'))), 'image/png');
    });
}

export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Safari resolves the URL after the click (same rule as ImagePreview).
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
