import { describe, expect, it } from 'vitest';
import { getPublicDoc, INSTALL_COMMAND, LOGIN_COMMAND, PUBLIC_DOCS } from './publicContent';

describe('public documentation registry', () => {
  it('provides every public-release topic with unique stable slugs', () => {
    expect(new Set(PUBLIC_DOCS.map((doc) => doc.slug)).size).toBe(PUBLIC_DOCS.length);
    expect(PUBLIC_DOCS.map((doc) => doc.slug)).toEqual(expect.arrayContaining([
      'quickstart', 'cli', 'cloud', 'self-hosting', 'configuration', 'architecture',
      'security', 'accounts-and-quotas', 'upgrades', 'troubleshooting', 'contributing',
    ]));
  });

  it('keeps onboarding commands and trust disclosure in the published content', () => {
    const text = JSON.stringify(PUBLIC_DOCS);
    expect(text).toContain(INSTALL_COMMAND);
    expect(text).toContain(LOGIN_COMMAND);
    expect(text).toContain('not end-to-end encrypted');
    expect(text).toContain('server-trusted');
  });

  it('resolves known slugs and rejects unknown routes', () => {
    expect(getPublicDoc('quickstart')?.label).toBe('Quick start');
    expect(getPublicDoc('missing')).toBeUndefined();
  });
});
