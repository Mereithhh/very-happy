/**
 * B-575: the settings search index must stay consistent with the real pages —
 * every indexed id has a `data-setting-id` anchor on its section's page, ids
 * are unique, and every translation key exists in both en and zh-Hans.
 * Behavioural render (installBrowserTestGlobals + renderToStaticMarkup, the
 * agentsSettingsRender.test.tsx precedent), not a source grep.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import { Window } from 'happy-dom';
import { en } from '@/text/_default';
import { zhHans } from '@/text/translations/zh-Hans';
import {
  SETTINGS_INDEX,
  SETTINGS_SECTION_TITLES,
  lookupText,
  searchSettings,
  textVariants,
  settingHref,
  type SettingsText,
} from './settingsIndex';

const push = vi.hoisted(() => ({ supported: true }));
vi.mock('@/sync/webPush', async (orig) => ({
  ...(await orig<typeof import('@/sync/webPush')>()),
  isWebPushSupported: () => push.supported,
}));
vi.mock('@/sync/webNotifications', async (orig) => ({
  ...(await orig<typeof import('@/sync/webNotifications')>()),
  getNotificationPermission: () => (push.supported ? 'default' : 'unsupported'),
}));

let SettingsRoutes: typeof import('./SettingsRoutes').SettingsRoutes;
let ToastProvider: typeof import('@/ui/Toast').ToastProvider;
let ThemeProvider: typeof import('@/ui/theme').ThemeProvider;
let AuthProvider: typeof import('@/auth/AuthContext').AuthProvider;
let settingsSections: typeof import('./SettingsLayout').settingsSections;

beforeAll(async () => {
  installBrowserTestGlobals();
  ({ ToastProvider } = await import('@/ui/Toast'));
  ({ ThemeProvider } = await import('@/ui/theme'));
  ({ AuthProvider } = await import('@/auth/AuthContext'));
  ({ SettingsRoutes } = await import('./SettingsRoutes'));
  ({ settingsSections } = await import('./SettingsLayout'));
});

function render(section: string): string {
  return renderToStaticMarkup(
    <AuthProvider initialCredentials={null}>
      <ThemeProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/settings${section ? `/${section}` : ''}`]}>
            <Routes>
              <Route path="/settings/*" element={<SettingsRoutes />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </ThemeProvider>
    </AuthProvider>,
  );
}

function anchorsIn(html: string): Set<string> {
  return new Set([...html.matchAll(/data-setting-id="([^"]+)"/g)].map((m) => m[1]));
}

function keysOf(text: SettingsText | undefined): string[] {
  return typeof text === 'string' ? [text] : [];
}

describe('settings index ↔ pages (B-575)', () => {
  it('ids are unique and every section exists in the settings navigation', () => {
    const ids = SETTINGS_INDEX.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const paths = new Set(settingsSections.map((s) => s.path));
    for (const e of SETTINGS_INDEX) expect(paths.has(e.section), e.id).toBe(true);
  });

  it('section titles match the navigation labels', () => {
    for (const s of settingsSections) {
      if (s.path === 'google') continue; // nav renders the literal "Google"
      expect(SETTINGS_SECTION_TITLES[s.path], s.path).toBe(s.key);
    }
  });

  it('every translation key resolves to a string in en and zh-Hans', () => {
    for (const e of SETTINGS_INDEX) {
      for (const key of [...keysOf(e.title), ...keysOf(e.description)]) {
        expect(lookupText(en, key), `${e.id} en ${key}`).toBeTypeOf('string');
        expect(lookupText(zhHans, key), `${e.id} zh ${key}`).toBeTypeOf('string');
      }
      expect(e.keywords.every((k) => k === k.toLowerCase()), e.id).toBe(true);
    }
  });

  it('every indexed id has its anchor on the section page (Web Push supported)', () => {
    push.supported = true;
    const sections = [...new Set(SETTINGS_INDEX.map((e) => e.section))];
    for (const section of sections) {
      const anchors = anchorsIn(render(section));
      for (const e of SETTINGS_INDEX.filter((x) => x.section === section)) {
        expect(anchors.has(e.id), `${e.id} missing on /settings/${section}`).toBe(true);
      }
    }
  });

  it("each anchor sits on the row/group whose visible title is the entry's title (no id on the wrong row)", () => {
    push.supported = true;
    const doc = new Window().document;
    for (const section of [...new Set(SETTINGS_INDEX.map((e) => e.section))]) {
      doc.body.innerHTML = render(section);
      for (const e of SETTINGS_INDEX.filter((x) => x.section === section)) {
        const el = doc.querySelector(`[data-setting-id="${e.id}"]`);
        const titleEl = el?.classList.contains('vh-itemgroup')
          ? [...el.children].find((c) => c.classList.contains('vh-itemgroup__title'))
          : el?.querySelector('.vh-item__title');
        const visible = (titleEl?.textContent ?? '').trim().toLowerCase();
        // renders in en (test locale); the index title must be what the user sees there
        expect(visible, `${e.id} on /settings/${section}`).toContain(textVariants(e.title).en.toLowerCase());
      }
    }
  });

  it('without Web Push only `requires:webPush` entries lose their anchor — and search hides them', () => {
    push.supported = false;
    try {
      const anchors = anchorsIn(render('notifications'));
      for (const e of SETTINGS_INDEX.filter((x) => x.section === 'notifications')) {
        expect(anchors.has(e.id), e.id).toBe(e.requires !== 'webPush');
      }
      expect(searchSettings('quiet', { webPush: false }).map((h) => h.entry.id)).not.toContain('notifications.quietHours');
    } finally {
      push.supported = true;
    }
  });
});

describe('searchSettings (B-575)', () => {
  const top = (q: string) => searchSettings(q, { webPush: true })[0]?.entry.id;

  it('finds items by zh title, en alias and zh alias', () => {
    expect(top('提示音')).toBe('notifications.sound');
    expect(top('sound')).toBe('notifications.sound');
    expect(top('quiet hours')).toBe('notifications.quietHours');
    expect(top('免打扰')).toBe('notifications.quietHours');
    expect(top('wrap')).toBe('appearance.wrapDiff');
    expect(top('换行')).toBe('appearance.wrapDiff');
    expect(top('Dark')).toBe('appearance.theme');
  });

  it('B-582: chat text size is found by 字号 / 字体大小 / font size / text size', () => {
    for (const q of ['字号', '字体大小', '对话字号', 'font size', 'text size']) expect(top(q)).toBe('appearance.chatTextSize');
  });

  it('a section name alone does not list the whole section; it narrows a combined query', () => {
    expect(searchSettings('诊断', { webPush: true })).toEqual([]);
    expect(top('通知 声音')).toBe('notifications.sound');
  });

  it('all terms must match (AND) and empty query returns nothing', () => {
    expect(searchSettings('sound zzzz', { webPush: true })).toEqual([]);
    expect(searchSettings('   ', { webPush: true })).toEqual([]);
  });

  it('title hits outrank keyword hits', () => {
    const ids = searchSettings('提示音', { webPush: true }).map((h) => h.entry.id);
    expect(ids.indexOf('notifications.sound')).toBeLessThan(ids.indexOf('voice.pttSound'));
  });

  it('deep link shape', () => {
    expect(settingHref({ id: 'notifications.quietHours', section: 'notifications' })).toBe('/settings/notifications?setting=notifications.quietHours');
    expect(settingHref({ id: 'x', section: '' }, '/dev/settings')).toBe('/dev/settings?setting=x');
  });
});
