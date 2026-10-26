/**
 * Owner 10-27 author credit: 「由 Mereith 开发 · GitHub」 on the public footers, share page,
 * login and Help, plus Settings → About. Behavioural renders (renderToStaticMarkup) of the
 * shared pieces, and the copy in en + zh-Hans with English fallback for the other languages.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import { AUTHOR_URL, EXTERNAL_LINK, NEW_ISSUE_URL, REPO_URL, buildCommitUrl, shortBuildId } from './attribution';
import { CreditLine } from '@/ui/CreditLine';

installBrowserTestGlobals();
const { Item } = await import('@/ui/Item');
const { getPublicCopy } = await import('@/i18n/publicI18n');
const { en } = await import('@/text/_default');
const { zhHans } = await import('@/text/translations/zh-Hans');

const SHA = '8f1e0f78a1b2c3d4e5f60718293a4b5c6d7e8f90';
const anchors = (html: string) => [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);

describe('attribution links', () => {
  it('points at the author profile, the repository and its new-issue form', () => {
    expect(AUTHOR_URL).toBe('https://github.com/Mereithhh');
    expect(REPO_URL).toBe('https://github.com/Mereithhh/very-happy');
    expect(NEW_ISSUE_URL).toBe('https://github.com/Mereithhh/very-happy/issues/new');
    expect(EXTERNAL_LINK).toEqual({ target: '_blank', rel: 'noopener noreferrer' });
  });

  it('shows a release sha as its 7-char short form with a commit link; other build ids as is', () => {
    expect(shortBuildId(SHA)).toBe('8f1e0f7');
    expect(buildCommitUrl(SHA)).toBe(`${REPO_URL}/commit/${SHA}`);
    expect(shortBuildId('2.0.0')).toBe('2.0.0');
    expect(buildCommitUrl('2.0.0')).toBeNull();
    expect(shortBuildId('20261027T0012')).toBe('20261027T0012');
  });
});

describe('CreditLine', () => {
  it('links the byline to the author and GitHub to the repo, both in a new tab without opener/referrer', () => {
    const html = renderToStaticMarkup(<CreditLine where="login" builtBy="Built by Mereith" sourceLabel="Very Happy source code on GitHub" />);
    expect(html).toContain('data-credit="login"');
    const [author, repo] = anchors(html);
    expect(author).toContain(`href="${AUTHOR_URL}"`);
    expect(repo).toContain(`href="${REPO_URL}"`);
    expect(repo).toContain('aria-label="Very Happy source code on GitHub"');
    for (const a of [author, repo]) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
    }
    expect(html).toContain('>Built by Mereith</a>');
    expect(html).toMatch(/<svg[^>]*>.*<\/svg>GitHub<\/a>/);
  });

  it('puts the share page lead first, separated like the rest', () => {
    const html = renderToStaticMarkup(<MemoryRouter><CreditLine where="share" lead={<span>Made with Very Happy</span>} builtBy="Built by Mereith" sourceLabel="src" /></MemoryRouter>);
    expect(html.indexOf('Made with Very Happy')).toBeLessThan(html.indexOf('Built by Mereith'));
    expect(html.match(/vh-credit__sep/g)).toHaveLength(2);
  });
});

describe('Item href (Settings → About rows)', () => {
  it('renders an off-site row as a new-tab link, and keeps button / plain rows unchanged', () => {
    const link = renderToStaticMarkup(<Item title="Source code" href={REPO_URL} />);
    expect(link).toMatch(/^<a class="vh-item is-interactive" href="https:\/\/github.com\/Mereithhh\/very-happy" target="_blank" rel="noopener noreferrer">/);
    expect(link).not.toContain('type=');
    const button = renderToStaticMarkup(<Item title="Help" onClick={() => {}} />);
    expect(button).toMatch(/^<button class="vh-item is-interactive" type="button">/);
    expect(renderToStaticMarkup(<Item title="Version" />)).toMatch(/^<div class="vh-item">/);
  });
});

describe('credit copy', () => {
  it('says 由 Mereith 开发 / Built by Mereith in both apps, English for other languages', () => {
    expect(getPublicCopy('en').shell.builtBy).toBe('Built by Mereith');
    expect(getPublicCopy('zh-Hans').shell.builtBy).toBe('由 Mereith 开发');
    expect(getPublicCopy('ja').shell.builtBy).toBe('Built by Mereith');
    expect(en.credit.builtBy).toBe('Built by Mereith');
    expect(zhHans.credit.builtBy).toBe('由 Mereith 开发');
    expect(en.credit.madeWith).toBe('Made with Very Happy');
    expect(zhHans.credit.madeWith).toBe('使用 Very Happy 制作');
    for (const copy of [en.settingsAbout, zhHans.settingsAbout]) for (const value of Object.values(copy)) expect(value).toBeTruthy();
  });
});
