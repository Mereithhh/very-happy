import { afterEach, describe, expect, it, vi } from 'vitest';
import { authReturnTarget, persistAuthReturnTarget } from './authReturnTarget';

afterEach(() => vi.unstubAllGlobals());

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

  it('preserves a safe reauthentication target across a hard reload and consumes it once', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      setItem: (key: string, value: string) => values.set(key, value),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    });
    expect(persistAuthReturnTarget({ pathname: '/settings/google', search: '', hash: '' } as any)).toBe(true);
    expect(authReturnTarget(undefined)).toBe('/settings/google');
    expect(authReturnTarget(undefined)).toBe('/');
    expect(persistAuthReturnTarget({ pathname: '//evil.example', search: '', hash: '' } as any)).toBe(false);
  });
});
