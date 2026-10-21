/**
 * B-624 white-label: a self-hosted relay can rename the product and hide the
 * marketing landing page. The server injects `brand` / `landing` into
 * `window.__HAPPY_CONFIG__` (standalone `BRAND_NAME`, `BRAND_LOGO_URL`,
 * `WEB_LANDING`); everything here is synchronous so the anonymous public root
 * and the prepaint splash can read it before React mounts.
 */
export const DEFAULT_BRAND_NAME = 'Very Happy';

export interface BrandConfig {
  /** Product name as shown in titles, loaders and settings. */
  name: string;
  /** Lower-case wordmark used by the auth cards; the default keeps the "very happy" lockup. */
  wordmark: string;
  /** Optional logo replacing the VeryHappyMark; http(s) URL or an absolute path. */
  logoUrl: string | null;
  /** B-638: dark-theme variant of `logoUrl` (shown via `brand.css` when the theme is dark). */
  logoDarkUrl: string | null;
  /** B-638: horizontal logo-with-text lockup used where there is room (auth cards, splash, public header). */
  wordmarkUrl: string | null;
  wordmarkDarkUrl: string | null;
  /** B-638: opaque square icon for the tab, home screen and link previews. */
  iconUrl: string | null;
  /** B-638: environment tag such as "Staging", shown as a badge next to the name and in the title. */
  envLabel: string | null;
  /** False hides `/` + `/welcome` marketing pages: anonymous visitors go straight to login. */
  landingEnabled: boolean;
  isDefault: boolean;
}

function readLogoUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function readBrandConfig(runtime: unknown = (globalThis as { __HAPPY_CONFIG__?: unknown }).__HAPPY_CONFIG__): BrandConfig {
  const config = runtime && typeof runtime === 'object' ? runtime as { brand?: unknown; landing?: unknown } : {};
  const brand = config.brand && typeof config.brand === 'object' ? config.brand as { name?: unknown; logoUrl?: unknown } : {};
  const rawName = typeof brand.name === 'string' ? brand.name.trim().slice(0, 64) : '';
  const name = rawName || DEFAULT_BRAND_NAME;
  const isDefault = name === DEFAULT_BRAND_NAME;
  const assets = brand as { logoDarkUrl?: unknown; wordmarkUrl?: unknown; wordmarkDarkUrl?: unknown; iconUrl?: unknown; envLabel?: unknown };
  const envLabel = typeof assets.envLabel === 'string' ? assets.envLabel.trim().slice(0, 24) : '';
  return {
    name,
    wordmark: isDefault ? 'very happy' : name,
    logoUrl: readLogoUrl(brand.logoUrl),
    logoDarkUrl: readLogoUrl(assets.logoDarkUrl),
    wordmarkUrl: readLogoUrl(assets.wordmarkUrl),
    wordmarkDarkUrl: readLogoUrl(assets.wordmarkDarkUrl),
    iconUrl: readLogoUrl(assets.iconUrl),
    envLabel: envLabel || null,
    landingEnabled: config.landing !== false,
    isDefault,
  };
}

/** Browser-tab title for a brand: the name, plus the environment tag when one is set. */
export function brandTitle(brand: BrandConfig = BRAND): string {
  return brand.envLabel ? `${brand.name} · ${brand.envLabel}` : brand.name;
}

export const BRAND: BrandConfig = readBrandConfig();

/** Swaps the product name inside copy that names it (page titles, shell chrome); no-op on the default brand. */
export function brandText(text: string, brand: BrandConfig = BRAND): string {
  if (brand.isDefault) return text;
  return text.replace(/Very Happy/g, brand.name).replace(/very happy/g, brand.wordmark);
}

/**
 * Deep copy of a string dictionary with every product-name mention swapped
 * (public landing/docs/PWA copy, which does not go through `t()`); returns the
 * same object on the default brand so React memoisation keeps working.
 */
export function brandCopy<T>(value: T, brand: BrandConfig = BRAND): T {
  if (brand.isDefault) return value;
  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') return brandText(node, brand);
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) out[key] = visit(child);
      return out;
    }
    return node;
  };
  return visit(value) as T;
}

/** Title + PWA title follow the brand; the default build keeps what index.html ships. */
export function applyBrandToDocument(brand: BrandConfig, doc: Document = document): void {
  if (brand.isDefault && !brand.envLabel && !brand.iconUrl) return;
  doc.title = brandTitle(brand);
  const pwaTitle = doc.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (pwaTitle) pwaTitle.setAttribute('content', brand.name);
  if (brand.iconUrl) {
    // The server already rewrites these for self-hosted bundles; this keeps
    // dev servers and injected configs consistent.
    for (const selector of ['link[rel="icon"]', 'link[rel="apple-touch-icon"]']) {
      const link = doc.querySelector(selector);
      if (link && link.getAttribute('href') !== brand.iconUrl) {
        link.setAttribute('href', brand.iconUrl);
        if (selector === 'link[rel="icon"]') link.removeAttribute('type');
      }
    }
  }
}
