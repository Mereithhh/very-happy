const RUNTIME_CONFIG_ID = 'vh-runtime-config';
const BRAND_STYLE_ID = 'vh-brand-style';

export function runtimeConfigScript(config: Record<string, unknown>): string {
    return `<script id="${RUNTIME_CONFIG_ID}">window.__HAPPY_CONFIG__ = ${JSON.stringify(config)};</script>`;
}

/**
 * Inject the runtime config at most once. SPA fallback responses pass through
 * Fastify's onSend hook after the fallback has already read and transformed
 * index.html, so an idempotent helper is required to avoid duplicate scripts.
 */
export function injectRuntimeConfig(html: string, script: string): string {
    if (html.includes(`id="${RUNTIME_CONFIG_ID}"`)) return html;
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n${script}`);
}

/** The `brand` object of the injected runtime config (B-624 / B-638). */
export interface HtmlBrand {
    name?: string;
    logoUrl?: string;
    logoDarkUrl?: string;
    wordmarkUrl?: string;
    wordmarkDarkUrl?: string;
    iconUrl?: string;
    envLabel?: string;
}

export function readHtmlBrand(config: Record<string, unknown> | undefined): HtmlBrand | null {
    const brand = config?.brand;
    if (!brand || typeof brand !== 'object') return null;
    const out: HtmlBrand = {};
    for (const key of ['name', 'logoUrl', 'logoDarkUrl', 'wordmarkUrl', 'wordmarkDarkUrl', 'iconUrl', 'envLabel'] as const) {
        const value = (brand as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.trim()) out[key] = value.trim();
    }
    return Object.keys(out).length > 0 ? out : null;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function absoluteUrl(url: string, origin: string | null): string {
    return url.startsWith('/') && origin ? `${origin}${url}` : url;
}

function imageType(url: string): string | null {
    const ext = url.split(/[?#]/)[0].split('.').pop()?.toLowerCase();
    if (ext === 'png') return 'image/png';
    if (ext === 'svg') return 'image/svg+xml';
    if (ext === 'ico') return 'image/x-icon';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    return null;
}

/**
 * Light/dark pair of an operator image. Rules mirror the app's `brand.css`
 * so the pre-paint splash already shows the right variant.
 */
export function brandImagePair(light: string, dark: string | undefined, className: string, alt: string, extraAttrs = ''): string {
    const img = (src: string, variant: 'light' | 'dark') => `<img class="${className} vh-brand-${variant}" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${extraAttrs}>`;
    return dark ? img(light, 'light') + img(dark, 'dark') : img(light, 'light').replace(' vh-brand-light', '');
}

export const BRAND_THEME_STYLE = `<style id="${BRAND_STYLE_ID}">
:root[data-theme='dark'] .vh-brand-light,:root[data-theme='light'] .vh-brand-dark{display:none}
@media (prefers-color-scheme:dark){:root:not([data-theme]) .vh-brand-light{display:none}}
@media (prefers-color-scheme:light){:root:not([data-theme]) .vh-brand-dark{display:none}}
.vh-startup-lockup{height:34px;width:auto;max-width:240px;margin:0 auto;display:block}
.vh-startup-hub-logo{width:42px;height:42px;object-fit:contain}
</style>`;

/**
 * B-638: rewrite the shipped index.html so the first paint, the browser tab,
 * the home-screen icon and link previews all carry the operator brand instead
 * of the default one. Idempotent; a no-op without a brand.
 */
export function applyBrandToHtml(html: string, brand: HtmlBrand | null, origin: string | null = null): string {
    if (!brand) return html;
    let out = html;
    const title = brand.name ? (brand.envLabel ? `${brand.name} · ${brand.envLabel}` : brand.name) : null;
    if (title) {
        out = out.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(title)}</title>`);
        out = out.replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/i, `$1${escapeHtml(brand.name!)}$2`);
        out = out.replace(/(<meta property="og:title" content=")[^"]*(")/i, `$1${escapeHtml(brand.name!)}$2`);
    }
    if (brand.iconUrl) {
        const type = imageType(brand.iconUrl);
        out = out.replace(/<link rel="apple-touch-icon" href="[^"]*" \/>/i, `<link rel="apple-touch-icon" href="${escapeHtml(brand.iconUrl)}" />`);
        out = out.replace(/<link rel="icon"[^>]*\/>/i, `<link rel="icon"${type ? ` type="${type}"` : ''} href="${escapeHtml(brand.iconUrl)}" />`);
        out = out.replace(/(<meta property="og:image" content=")[^"]*(")/i, `$1${escapeHtml(absoluteUrl(brand.iconUrl, origin))}$2`);
        // B-724: the default card is a 1200×630 image; a square operator icon is a small card.
        out = out.replace(/\s*<meta property="og:image:(?:width|height)" content="[^"]*" \/>/gi, '');
        out = out.replace(/(<meta name="twitter:card" content=")summary_large_image(")/i, '$1summary$2');
    }
    if (brand.logoUrl) {
        // The splash network's hub is the default mark; show the operator's.
        out = out.replace(/(<div class="vh-startup-hub">)<svg[\s\S]*?<\/svg>(<\/div>)/i, (_m, open, close) =>
            `${open}${brandImagePair(brand.logoUrl!, brand.logoDarkUrl, 'vh-startup-hub-logo', '')}${close}`);
    }
    if (brand.name || brand.wordmarkUrl) {
        out = out.replace(/<strong class="vh-startup-wordmark">[^<]*<\/strong>/i, () => brand.wordmarkUrl
            ? brandImagePair(brand.wordmarkUrl, brand.wordmarkDarkUrl, 'vh-startup-lockup', brand.name ?? '')
            : `<strong class="vh-startup-wordmark">${escapeHtml(brand.name!)}</strong>`);
    }
    if (!out.includes(`id="${BRAND_STYLE_ID}"`)) out = out.replace(/<\/head>/i, `${BRAND_THEME_STYLE}\n</head>`);
    return out;
}

/** Everything the server does to the shipped index.html before it leaves. */
export function transformIndexHtml(html: string, script: string | null, brand: HtmlBrand | null, origin: string | null = null): string {
    const withConfig = script ? injectRuntimeConfig(html, script) : html;
    return applyBrandToHtml(withConfig, brand, origin);
}

/** B-638: the PWA manifest follows the brand too (installed app name and icons). */
export function applyBrandToManifest(manifestJson: string, brand: HtmlBrand | null): string {
    if (!brand) return manifestJson;
    let manifest: Record<string, unknown>;
    try {
        manifest = JSON.parse(manifestJson);
    } catch {
        return manifestJson;
    }
    if (!manifest || typeof manifest !== 'object') return manifestJson;
    if (brand.name) {
        manifest.name = brand.envLabel ? `${brand.name} (${brand.envLabel})` : brand.name;
        manifest.short_name = brand.name;
    }
    if (brand.iconUrl) {
        const type = imageType(brand.iconUrl) ?? 'image/png';
        manifest.icons = [
            { src: brand.iconUrl, sizes: '192x192', type },
            { src: brand.iconUrl, sizes: '512x512', type },
            { src: brand.iconUrl, sizes: '512x512', type, purpose: 'maskable' },
        ];
    }
    return JSON.stringify(manifest);
}
