import { describe, expect, it } from 'vitest';
import { formatRelayRegion } from './relayRegionLabel';

describe('relay region label', () => {
  it('shows a country flag without exposing an internal relay id', () => {
    expect(formatRelayRegion('Singapore')).toBe('🇸🇬 Singapore');
    expect(formatRelayRegion('US West')).toBe('🇺🇸 US West');
  });

  it('keeps unknown region names instead of guessing a flag', () => {
    expect(formatRelayRegion('Europe Central')).toBe('Europe Central');
    expect(formatRelayRegion()).toBe('Regional relay');
  });
});
