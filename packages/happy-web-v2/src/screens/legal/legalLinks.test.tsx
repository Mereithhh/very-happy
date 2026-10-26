/**
 * QA16 P2-3: the private-reporting link in the Privacy / Terms body is off-site, so it opens
 * in a new tab with noopener like every other external link (B-834 EXTERNAL_LINK).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

const lang = vi.hoisted(() => ({ value: 'en' as 'en' | 'zh-Hans' }));
vi.mock('@/i18n/publicI18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n/publicI18n')>();
  return { ...actual, usePublicI18n: () => ({ ...actual.usePublicI18n(), language: lang.value, copy: actual.getPublicCopy(lang.value) }) };
});

let screens: typeof import('./PublicLegalScreen');
beforeAll(async () => {
  installBrowserTestGlobals();
  screens = await import('./PublicLegalScreen');
});

const ADVISORIES = 'https://github.com/Mereithhh/very-happy/security/advisories/new';

describe('legal body links', () => {
  for (const language of ['en', 'zh-Hans'] as const) {
    for (const name of ['PrivacyScreen', 'TermsScreen'] as const) {
      it(`${name} (${language}): every advisories link opens a new tab with noopener`, () => {
        lang.value = language;
        const Screen = screens[name];
        const html = renderToStaticMarkup(<MemoryRouter><Screen /></MemoryRouter>);
        const anchors = html.match(new RegExp(`<a [^>]*href="${ADVISORIES}"[^>]*>`, 'g')) ?? [];
        expect(anchors.length).toBeGreaterThan(0);
        for (const a of anchors) expect(a).toContain('target="_blank" rel="noopener noreferrer"');
      });
    }
  }
});
