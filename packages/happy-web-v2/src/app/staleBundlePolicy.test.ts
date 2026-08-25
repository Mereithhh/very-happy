import { describe, expect, it } from 'vitest';
import {
  decideStaleBundleReload,
  parseStaleBundleReloadGuard,
  serializeStaleBundleReloadGuard,
  STALE_BUNDLE_RELOAD_GUARD_MS,
} from './staleBundlePolicy';

describe('stale bundle reload policy', () => {
  it('reloads immediately when a second deployment has a different entry', () => {
    const guard = serializeStaleBundleReloadGuard({ entry: 'index-release-b.js', attemptedAt: 1_000 });
    expect(decideStaleBundleReload(guard, 'index-release-c.js', 2_000)).toEqual({ action: 'reload' });
  });

  it('guards a repeated attempt for the same entry and exposes the retry delay', () => {
    const guard = serializeStaleBundleReloadGuard({ entry: 'index-release-b.js', attemptedAt: 1_000 });
    expect(decideStaleBundleReload(guard, 'index-release-b.js', 2_000)).toEqual({
      action: 'wait',
      retryAfterMs: STALE_BUNDLE_RELOAD_GUARD_MS - 1_000,
    });
  });

  it('retries the same entry after the guard expires', () => {
    const guard = serializeStaleBundleReloadGuard({ entry: 'index-release-b.js', attemptedAt: 1_000 });
    expect(decideStaleBundleReload(
      guard,
      'index-release-b.js',
      1_000 + STALE_BUNDLE_RELOAD_GUARD_MS,
    )).toEqual({ action: 'reload' });
  });

  it('fails open for absent, legacy, or malformed guard data', () => {
    expect(decideStaleBundleReload(null, 'index-release-b.js', 2_000)).toEqual({ action: 'reload' });
    expect(decideStaleBundleReload('1000', 'index-release-b.js', 2_000)).toEqual({ action: 'reload' });
    expect(decideStaleBundleReload('{broken', 'index-release-b.js', 2_000)).toEqual({ action: 'reload' });
    expect(parseStaleBundleReloadGuard('{"entry":"","attemptedAt":1000}')).toBeNull();
  });
});
