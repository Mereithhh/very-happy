import { describe, expect, it } from 'vitest';
import { applyBrandToHtml, applyBrandToManifest, injectRuntimeConfig, readHtmlBrand, runtimeConfigScript, transformIndexHtml } from './htmlConfigInjection';

describe('runtime HTML config injection', () => {
    it('serializes the config into a stable marked script', () => {
        expect(runtimeConfigScript({ serverUrl: 'same-origin' })).toBe(
            '<script id="vh-runtime-config">window.__HAPPY_CONFIG__ = {"serverUrl":"same-origin"};</script>',
        );
    });

    it('is idempotent when SPA fallback output passes through onSend', () => {
        const script = runtimeConfigScript({ serverUrl: 'https://relay.example' });
        const once = injectRuntimeConfig('<html><head></head><body></body></html>', script);
        const twice = injectRuntimeConfig(once, script);
        expect(twice).toBe(once);
        expect(twice.match(/__HAPPY_CONFIG__/g)).toHaveLength(1);
    });

    const INDEX = `<html><head><title>Very Happy</title>
<meta name="apple-mobile-web-app-title" content="Very Happy" />
<link rel="apple-touch-icon" href="apple-touch-icon.png" />
<link rel="icon" type="image/png" sizes="32x32" href="favicon.png" />
<meta property="og:title" content="Very Happy — tagline" />
<meta property="og:image" content="https://veryhappy.dev/og-image.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
</head><body><div class="vh-startup-hub"><svg viewBox="0 0 96 96"><path/></svg></div><strong class="vh-startup-wordmark">Very Happy</strong></body></html>`;

    it('B-638: rewrites title, icons, link preview and the splash for an operator brand', () => {
        const brand = readHtmlBrand({ brand: { name: 'Apodex Vibe', logoUrl: '/brand/i.svg', logoDarkUrl: '/brand/i-dark.svg', iconUrl: '/brand/icon-512.png', wordmarkUrl: '/brand/w.svg', wordmarkDarkUrl: '/brand/w-dark.svg', envLabel: 'Staging' } });
        const html = applyBrandToHtml(INDEX, brand, 'https://vibe.example');
        expect(html).toContain('<title>Apodex Vibe · Staging</title>');
        expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Apodex Vibe" />');
        expect(html).toContain('<link rel="apple-touch-icon" href="/brand/icon-512.png" />');
        expect(html).toContain('<link rel="icon" type="image/png" href="/brand/icon-512.png" />');
        expect(html).toContain('<meta property="og:title" content="Apodex Vibe" />');
        expect(html).toContain('<meta property="og:image" content="https://vibe.example/brand/icon-512.png" />');
        expect(html).not.toContain('og:image:width');
        expect(html).toContain('<meta name="twitter:card" content="summary" />');
        expect(html).toContain('<img class="vh-startup-lockup vh-brand-light" src="/brand/w.svg" alt="Apodex Vibe">');
        expect(html).toContain('<img class="vh-startup-lockup vh-brand-dark" src="/brand/w-dark.svg" alt="Apodex Vibe">');
        expect(html).not.toContain('vh-startup-wordmark');
        expect(html).toContain('<div class="vh-startup-hub"><img class="vh-startup-hub-logo vh-brand-light" src="/brand/i.svg" alt=""><img class="vh-startup-hub-logo vh-brand-dark" src="/brand/i-dark.svg" alt=""></div>');
        expect(html).not.toContain('<svg viewBox="0 0 96 96">');
        expect(html.match(/id="vh-brand-style"/g)).toHaveLength(1);
        expect(applyBrandToHtml(html, brand, 'https://vibe.example')).toBe(html);
    });

    it('B-638: a name-only brand keeps the text wordmark and the shipped icons; no brand is a no-op', () => {
        const html = applyBrandToHtml(INDEX, readHtmlBrand({ brand: { name: 'Acme' } }));
        expect(html).toContain('<title>Acme</title>');
        expect(html).toContain('<strong class="vh-startup-wordmark">Acme</strong>');
        expect(html).toContain('<div class="vh-startup-hub"><svg viewBox="0 0 96 96"><path/></svg></div>');
        expect(html).toContain('href="favicon.png"');
        expect(html).toContain('og:image" content="https://veryhappy.dev/og-image.png"');
        expect(applyBrandToHtml(INDEX, null)).toBe(INDEX);
        expect(readHtmlBrand({ serverUrl: 'same-origin' })).toBeNull();
        expect(transformIndexHtml(INDEX, runtimeConfigScript({ a: 1 }), null)).toContain('__HAPPY_CONFIG__');
    });

    it('B-638: the PWA manifest follows the brand name, label and icon', () => {
        const manifest = JSON.stringify({ name: 'Very Happy', short_name: 'Very Happy', icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }], start_url: '/' });
        const out = JSON.parse(applyBrandToManifest(manifest, readHtmlBrand({ brand: { name: 'Apodex Vibe', envLabel: 'Staging', iconUrl: '/brand/icon-512.png' } })));
        expect(out).toMatchObject({ name: 'Apodex Vibe (Staging)', short_name: 'Apodex Vibe', start_url: '/' });
        expect(out.icons).toEqual([
            { src: '/brand/icon-512.png', sizes: '192x192', type: 'image/png' },
            { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ]);
        expect(JSON.parse(applyBrandToManifest(manifest, readHtmlBrand({ brand: { name: 'Acme' } }))).icons).toHaveLength(1);
        expect(applyBrandToManifest('not json', readHtmlBrand({ brand: { name: 'Acme' } }))).toBe('not json');
        expect(applyBrandToManifest(manifest, null)).toBe(manifest);
    });
});
