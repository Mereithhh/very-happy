import { describe, expect, it } from 'vitest';
import { applyBrandToDocument, brandCopy, brandText, brandTitle, DEFAULT_BRAND_NAME, readBrandConfig } from './brand';

describe('B-624 brand config', () => {
  it('defaults to the Very Happy lockup with the landing page on', () => {
    expect(readBrandConfig(undefined)).toEqual({ name: DEFAULT_BRAND_NAME, wordmark: 'very happy', logoUrl: null, logoDarkUrl: null, wordmarkUrl: null, wordmarkDarkUrl: null, iconUrl: null, envLabel: null, landingEnabled: true, isDefault: true });
    expect(readBrandConfig({ serverUrl: 'same-origin' })).toMatchObject({ isDefault: true, landingEnabled: true });
    expect(readBrandConfig({ brand: { name: '   ' }, landing: true })).toMatchObject({ name: DEFAULT_BRAND_NAME, isDefault: true });
  });

  it('takes the operator name, a safe logo URL, and the landing switch', () => {
    expect(readBrandConfig({ brand: { name: ' Apodex Vibe ', logoUrl: 'https://cdn.example.com/logo.svg' }, landing: false })).toEqual({
      name: 'Apodex Vibe', wordmark: 'Apodex Vibe', logoUrl: 'https://cdn.example.com/logo.svg', logoDarkUrl: null, wordmarkUrl: null, wordmarkDarkUrl: null, iconUrl: null, envLabel: null, landingEnabled: false, isDefault: false,
    });
    expect(readBrandConfig({ brand: { logoUrl: '/brand/logo.png' } }).logoUrl).toBe('/brand/logo.png');
    expect(readBrandConfig({ brand: { logoUrl: 'javascript:alert(1)' } }).logoUrl).toBeNull();
    expect(readBrandConfig({ brand: { logoUrl: '//evil.example.com/x.png' } }).logoUrl).toBeNull();
    expect(readBrandConfig({ brand: { name: 'x'.repeat(100) } }).name).toHaveLength(64);
    expect(readBrandConfig({ landing: 'off' }).landingEnabled).toBe(true);
  });

  it('rewrites product-name copy only for a custom brand', () => {
    expect(brandText('Sign in — Very Happy', readBrandConfig(undefined))).toBe('Sign in — Very Happy');
    const apodex = readBrandConfig({ brand: { name: 'Apodex Vibe' } });
    expect(brandText('登录 — Very Happy', apodex)).toBe('登录 — Apodex Vibe');
    expect(brandText('very happy · Very Happy CLI', apodex)).toBe('Apodex Vibe · Apodex Vibe CLI');
  });

  it('B-638: reads the asset pair, icon and environment label; the title carries the label', () => {
    const brand = readBrandConfig({ brand: { name: 'Apodex Vibe', logoUrl: '/brand/i.svg', logoDarkUrl: '/brand/i-dark.svg', wordmarkUrl: '/brand/w.svg', wordmarkDarkUrl: 'javascript:x', iconUrl: '/brand/icon-512.png', envLabel: '  测试环境 ' } });
    expect(brand).toMatchObject({ logoDarkUrl: '/brand/i-dark.svg', wordmarkUrl: '/brand/w.svg', wordmarkDarkUrl: null, iconUrl: '/brand/icon-512.png', envLabel: '测试环境' });
    expect(brandTitle(brand)).toBe('Apodex Vibe · 测试环境');
    expect(brandTitle(readBrandConfig({ brand: { name: 'Apodex Vibe' } }))).toBe('Apodex Vibe');
    expect(readBrandConfig({ brand: { envLabel: 'x'.repeat(40) } }).envLabel).toHaveLength(24);
  });

  it('B-637: deep-copies a dictionary with the name swapped, and keeps the default object identity', () => {
    const copy = { pwa: { title: 'Install Very Happy', steps: ['Open very happy', 'Done'] }, n: 3 };
    expect(brandCopy(copy, readBrandConfig(undefined))).toBe(copy);
    expect(brandCopy(copy, readBrandConfig({ brand: { name: 'Apodex Vibe' } }))).toEqual({ pwa: { title: 'Install Apodex Vibe', steps: ['Open Apodex Vibe', 'Done'] }, n: 3 });
    expect(copy.pwa.title).toBe('Install Very Happy');
  });

  it('retitles the document only for a custom brand', () => {
    const meta = { content: 'Very Happy', getAttribute: (_: string) => meta.content, setAttribute: (_: string, v: string) => { meta.content = v; } };
    const doc = { title: 'Very Happy', querySelector: () => meta } as unknown as Document;
    applyBrandToDocument(readBrandConfig(undefined), doc);
    expect(doc.title).toBe('Very Happy');
    applyBrandToDocument(readBrandConfig({ brand: { name: 'Apodex Vibe' } }), doc);
    expect(doc.title).toBe('Apodex Vibe');
    expect(meta.getAttribute('content')).toBe('Apodex Vibe');
    applyBrandToDocument(readBrandConfig({ brand: { name: 'Apodex Vibe', envLabel: 'Staging' } }), doc);
    expect(doc.title).toBe('Apodex Vibe · Staging');
    expect(meta.getAttribute('content')).toBe('Apodex Vibe');
  });
});
