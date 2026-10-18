import { describe, expect, it } from 'vitest';
import { applyBrandToDocument, DEFAULT_BRAND_NAME, readBrandConfig } from './brand';

describe('B-624 brand config', () => {
  it('defaults to the Very Happy lockup with the landing page on', () => {
    expect(readBrandConfig(undefined)).toEqual({ name: DEFAULT_BRAND_NAME, wordmark: 'very happy', logoUrl: null, landingEnabled: true, isDefault: true });
    expect(readBrandConfig({ serverUrl: 'same-origin' })).toMatchObject({ isDefault: true, landingEnabled: true });
    expect(readBrandConfig({ brand: { name: '   ' }, landing: true })).toMatchObject({ name: DEFAULT_BRAND_NAME, isDefault: true });
  });

  it('takes the operator name, a safe logo URL, and the landing switch', () => {
    expect(readBrandConfig({ brand: { name: ' Apodex Vibe ', logoUrl: 'https://cdn.example.com/logo.svg' }, landing: false })).toEqual({
      name: 'Apodex Vibe', wordmark: 'Apodex Vibe', logoUrl: 'https://cdn.example.com/logo.svg', landingEnabled: false, isDefault: false,
    });
    expect(readBrandConfig({ brand: { logoUrl: '/brand/logo.png' } }).logoUrl).toBe('/brand/logo.png');
    expect(readBrandConfig({ brand: { logoUrl: 'javascript:alert(1)' } }).logoUrl).toBeNull();
    expect(readBrandConfig({ brand: { logoUrl: '//evil.example.com/x.png' } }).logoUrl).toBeNull();
    expect(readBrandConfig({ brand: { name: 'x'.repeat(100) } }).name).toHaveLength(64);
    expect(readBrandConfig({ landing: 'off' }).landingEnabled).toBe(true);
  });

  it('retitles the document only for a custom brand', () => {
    const meta = { content: 'Very Happy', getAttribute: (_: string) => meta.content, setAttribute: (_: string, v: string) => { meta.content = v; } };
    const doc = { title: 'Very Happy', querySelector: () => meta } as unknown as Document;
    applyBrandToDocument(readBrandConfig(undefined), doc);
    expect(doc.title).toBe('Very Happy');
    applyBrandToDocument(readBrandConfig({ brand: { name: 'Apodex Vibe' } }), doc);
    expect(doc.title).toBe('Apodex Vibe');
    expect(meta.getAttribute('content')).toBe('Apodex Vibe');
  });
});
