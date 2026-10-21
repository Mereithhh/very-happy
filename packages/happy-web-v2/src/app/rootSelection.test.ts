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

  it('B-624: with the landing page off, / and /welcome go to the app root while docs and legal stay public', () => {
    for (const path of ['/', '/welcome', '/welcome/']) {
      expect(shouldUsePublicRoot(path, false, false)).toBe(false);
      expect(shouldUsePublicRoot(path, true, false)).toBe(false);
    }
    expect(shouldUsePublicRoot('/docs', false, false)).toBe(true);
    expect(shouldUsePublicRoot('/privacy', false, false)).toBe(true);
    expect(shouldUsePublicRoot('/', false, true)).toBe(true);
  });

  it.each(['/login', '/signup', '/session/example', '/terminal/connect', '/welcomes'])(
    'uses the authenticated application root for non-public paths: %s',
    (path) => {
      expect(shouldUsePublicRoot(path, false)).toBe(false);
      expect(shouldUsePublicRoot(path, true)).toBe(false);
    },
  );

  it('B-701: share links always open the anonymous viewer, signed in or not, landing or not', () => {
    for (const creds of [false, true]) for (const landing of [false, true]) {
      expect(shouldUsePublicRoot('/s/cmabc123', creds, landing)).toBe(true);
    }
    expect(shouldUsePublicRoot('/s', true)).toBe(false);
    expect(shouldUsePublicRoot('/s/a/b', true)).toBe(false);
    expect(shouldUsePublicRoot('/sessions', true)).toBe(false);
  });
});
