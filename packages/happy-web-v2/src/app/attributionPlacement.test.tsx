/**
 * Owner 10-27: every place the credit must appear actually mounts it. Settings → About is
 * rendered; the full-page screens (login, share, public shell, help) are pinned at the mount
 * line (each assertion verified with scripts/dev/mutation-check.mjs).
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import { AUTHOR_URL, NEW_ISSUE_URL, REPO_URL } from './attribution';

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

let AboutSettings: typeof import('@/screens/settings/AboutSettings').AboutSettings;
beforeAll(async () => {
  installBrowserTestGlobals();
  ({ AboutSettings } = await import('@/screens/settings/AboutSettings'));
});

describe('Settings → About', () => {
  it('links the author, the source and the new-issue form in a new tab, and shows the build id', () => {
    const html = renderToStaticMarkup(<MemoryRouter><AboutSettings /></MemoryRouter>);
    for (const href of [AUTHOR_URL, REPO_URL, NEW_ISSUE_URL]) {
      expect(html).toContain(`href="${href}" target="_blank" rel="noopener noreferrer"`);
    }
    expect(html).toContain(`>${__APP_VERSION__}</span>`);
  });

  it('is a settings route reached from the overview row (no longer a modal)', () => {
    const routes = src('screens/settings/SettingsRoutes.tsx');
    expect(routes).toContain('<Route path="about" element={<AboutSettings />} />');
    expect(routes).toContain("onClick={() => navigate('/settings/about')}");
    expect(src('screens/settings/SettingsLayout.tsx')).toContain("{path:'about',key:'settings.about',icon:Info}");
  });
});

describe('credit placements', () => {
  it('public footer (Landing + Docs) and the legal pages', () => {
    expect(src('screens/public/PublicShell.tsx')).toContain('<CreditLine where="public-footer"');
    expect(src('screens/legal/PublicLegalScreen.tsx')).toContain('<CreditLine where="legal-footer"');
  });

  it('login footer', () => {
    expect(src('screens/auth/LoginScreen.tsx')).toMatch(/<CreditLine where="login" builtBy=\{t\('credit\.builtBy'\)\}/);
  });

  it('share page: under the transcript when ready, at the bottom of every other phase', () => {
    const share = src('screens/public/SharedLinkScreen.tsx');
    expect(share).toMatch(/<\/p>\n\s+\{credit\}\n/);
    expect(share).toContain("{phase !== 'ready' && credit}");
    expect(share).toContain("builtBy={t('credit.byAuthor')}");
    expect(share).toContain("lead={BRAND.landingEnabled ? <Link to=\"/welcome\">{t('credit.madeWith')}</Link>");
  });

  it('Help: an About entry and the credit line', () => {
    const help = src('screens/help/HelpScreen.tsx');
    expect(help).toContain("onClick={() => navigate('/settings/about')}");
    expect(help).toContain('<CreditLine where="help"');
  });

  it('every off-site link these pages add opens in a new tab with noopener', () => {
    const shell = src('screens/public/PublicShell.tsx');
    expect(shell).toContain('href={GITHUB_URL} {...EXTERNAL_LINK}>GitHub</a>');
    expect(shell).toContain('href={GITHUB_URL} {...EXTERNAL_LINK}>{copy.shell.source}</a>');
    expect(src('screens/legal/PublicLegalScreen.tsx')).toContain('href={REPO_URL} {...EXTERNAL_LINK}>{copy.shell.source}</a>');
    expect(src('screens/public/LandingScreen.tsx')).toContain('href={GITHUB_URL} {...EXTERNAL_LINK}><Github size={16} />');
  });
});
