/** B-638: the startup artwork hub follows the operator logo. */
import { describe, expect, it } from 'vitest';
import { readBrandConfig } from '@/app/brand';
import { brandedArtwork } from './StartupLoader';

const ART = '<div class="vh-startup-network"><div class="vh-startup-hub"><svg viewBox="0 0 96 96"><path/></svg></div></div>';

describe('brandedArtwork', () => {
  it('keeps the default mark without a logo and swaps in the light/dark pair with one', () => {
    expect(brandedArtwork(ART, readBrandConfig(undefined))).toBe(ART);
    const out = brandedArtwork(ART, readBrandConfig({ brand: { name: 'Apodex Vibe', logoUrl: '/brand/i.svg', logoDarkUrl: '/brand/i-dark.svg' } }));
    expect(out).toBe('<div class="vh-startup-network"><div class="vh-startup-hub"><img class="vh-startup-hub-logo vh-brand-light" src="/brand/i.svg" alt=""><img class="vh-startup-hub-logo vh-brand-dark" src="/brand/i-dark.svg" alt=""></div></div>');
    expect(brandedArtwork(ART, readBrandConfig({ brand: { logoUrl: '/brand/i.png' } }))).toContain('<img class="vh-startup-hub-logo" src="/brand/i.png" alt="">');
  });
});
