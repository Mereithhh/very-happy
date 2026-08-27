import { describe, expect, it } from 'vitest';
import { relayRegionLabel } from './relayLabel';

describe('relayRegionLabel', () => {
  it('uses the actual assigned regional relay when connected', () => {
    expect(relayRegionLabel({ transport: 'regional', state: 'connected', region: 'US West' }, 'https://veryhappy.dev')).toBe('🇺🇸 US WEST');
  });

  it('labels the hosted origin honestly during regional fallback', () => {
    expect(relayRegionLabel({ transport: 'legacy', state: 'fallback' }, 'https://veryhappy.dev')).toBe('🇸🇬 SG');
    expect(relayRegionLabel({ transport: 'legacy', state: 'fallback' }, 'https://relay.example')).toBe('ORIGIN');
  });
});
