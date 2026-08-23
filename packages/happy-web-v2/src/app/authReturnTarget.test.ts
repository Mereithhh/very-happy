import { describe, expect, it } from 'vitest';
import { authReturnTarget } from './authReturnTarget';

describe('authReturnTarget', () => {
  it('preserves an in-app terminal pairing hash', () => {
    expect(authReturnTarget({ from: { pathname: '/terminal/connect', search: '', hash: '#key=abc' } }))
      .toBe('/terminal/connect#key=abc');
  });

  it('falls back for missing or external targets', () => {
    expect(authReturnTarget(undefined)).toBe('/');
    expect(authReturnTarget({ from: { pathname: '//evil.example', hash: '#key=abc' } })).toBe('/');
    expect(authReturnTarget({ from: { pathname: '/\\evil.example' } })).toBe('/');
    expect(authReturnTarget({ from: { pathname: 'https://evil.example' } })).toBe('/');
  });
});
