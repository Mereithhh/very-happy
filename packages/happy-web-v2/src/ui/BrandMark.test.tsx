/** B-638: operator brand assets — themed logo pairs, lockup, environment badge. */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readBrandConfig } from '@/app/brand';
import { BrandEnvBadge, BrandIcon, BrandLockup, BrandMark } from './BrandMark';

const apodex = readBrandConfig({ brand: {
  name: 'Apodex Vibe', logoUrl: '/brand/icon.svg', logoDarkUrl: '/brand/icon-dark.svg',
  wordmarkUrl: '/brand/wordmark.svg', wordmarkDarkUrl: '/brand/wordmark-dark.svg', envLabel: 'Staging',
} });
const plain = readBrandConfig({ brand: { name: 'Acme', logoUrl: '/brand/acme.png' } });

describe('B-638 brand components', () => {
  it('BrandIcon renders the light/dark pair, a single image, or the default mark', () => {
    const pair = renderToStaticMarkup(<BrandIcon size={18} brand={apodex} />);
    expect(pair).toContain('class="brand-icon vh-brand-light" src="/brand/icon.svg"');
    expect(pair).toContain('class="brand-icon vh-brand-dark" src="/brand/icon-dark.svg"');
    const single = renderToStaticMarkup(<BrandIcon size={18} brand={plain} />);
    expect(single).toContain('src="/brand/acme.png"');
    expect(single).not.toContain('vh-brand-');
    expect(renderToStaticMarkup(<BrandIcon size={18} brand={readBrandConfig(undefined)} />)).toContain('<svg');
  });

  it('BrandEnvBadge shows only when an environment label is set', () => {
    expect(renderToStaticMarkup(<BrandEnvBadge brand={apodex} />)).toContain('class="brand-env">Staging<');
    expect(renderToStaticMarkup(<BrandEnvBadge brand={plain} />)).toBe('');
  });

  it('BrandLockup uses the wordmark pair when configured and falls back to the mark + name', () => {
    const lockup = renderToStaticMarkup(<BrandLockup height={36} size={40} brand={apodex} className="auth-brand" />);
    expect(lockup).toContain('class="brand-lockup auth-brand"');
    expect(lockup).toContain('src="/brand/wordmark.svg" alt="Apodex Vibe"');
    expect(lockup).toContain('src="/brand/wordmark-dark.svg"');
    const fallback = renderToStaticMarkup(<BrandLockup height={36} size={40} brand={plain} wordmarkClassName="auth-wordmark" />);
    expect(fallback).toContain('src="/brand/acme.png"');
    expect(fallback).toContain('class="auth-wordmark">Acme<');
  });

  it('BrandMark keeps the default lockup for the default brand', () => {
    const html = renderToStaticMarkup(<BrandMark size={28} wordmarkClassName="w" />);
    expect(html).toContain('<svg');
    expect(html).toContain('class="w">very happy<');
  });
});
