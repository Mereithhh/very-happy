import { describe, expect, it } from 'vitest';
import { shouldUsePublicRoot } from './rootSelection';

describe('shouldUsePublicRoot', () => {
  it.each(['/welcome', '/welcome/'])(
    'keeps the stable marketing route public with stored credentials: %s',
    (path) => {
      expect(shouldUsePublicRoot(path, true)).toBe(true);
      expect(shouldUsePublicRoot(path, false)).toBe(true);
    },
  );

  it('preserves the root compatibility behavior', () => {
    expect(shouldUsePublicRoot('/', false)).toBe(true);
    expect(shouldUsePublicRoot('/', true)).toBe(false);
  });

  it.each(['/docs', '/docs/security', '/privacy', '/terms/'])(
    'keeps other anonymous pages lightweight without bypassing the app root for returning users: %s',
    (path) => {
      expect(shouldUsePublicRoot(path, false)).toBe(true);
      expect(shouldUsePublicRoot(path, true)).toBe(false);
    },
  );

  it.each(['/login', '/signup', '/session/example', '/terminal/connect', '/welcomes'])(
    'uses the authenticated application root for non-public paths: %s',
    (path) => {
      expect(shouldUsePublicRoot(path, false)).toBe(false);
      expect(shouldUsePublicRoot(path, true)).toBe(false);
    },
  );
});
