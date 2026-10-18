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
  /** Optional logo replacing the CyberMark; http(s) URL or an absolute path. */
  logoUrl: string | null;
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
  return {
    name,
    wordmark: isDefault ? 'very happy' : name,
    logoUrl: readLogoUrl(brand.logoUrl),
    landingEnabled: config.landing !== false,
    isDefault,
  };
}

export const BRAND: BrandConfig = readBrandConfig();

/** Swaps the product name inside copy that names it (page titles, shell chrome); no-op on the default brand. */
export function brandText(text: string, brand: BrandConfig = BRAND): string {
  if (brand.isDefault) return text;
  return text.replace(/Very Happy/g, brand.name).replace(/very happy/g, brand.wordmark);
}

/** Title + PWA title follow the brand; the default build keeps what index.html ships. */
export function applyBrandToDocument(brand: BrandConfig, doc: Document = document): void {
  if (brand.isDefault) return;
  doc.title = brand.name;
  const pwaTitle = doc.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (pwaTitle) pwaTitle.setAttribute('content', brand.name);
}
