// @vitest-environment happy-dom
// B-974g — a release note can wait for a server feature (`/v1/features`): until
// then it is not listed, not unread and never marked read.
import { act, createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_SERVER_FEATURE } from '@slopus/happy-wire';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string, args?: object) => (args ? `${key}:${JSON.stringify(args)}` : key), lang: 'en' }) }));
const machines: unknown[] = [];
vi.mock('@/sync/storage', () => ({ useAllMachines: () => machines }));
vi.mock('@/ui', () => ({ useToast: () => ({ success() {}, error() {}, show() {} }), useTheme: () => ({ resolved: 'light' }) }));
vi.mock('@/screens/search/sessionSearchEvents', () => ({ openSessionSearch: () => {} }));
vi.mock('@/i18n/publicI18n', () => ({ usePublicI18n: () => ({ copy: { whatsNew: {} } }) }));
vi.mock('@/app/BackButton', () => ({ BackButton: () => null }));
const auth = vi.hoisted(() => ({ value: { credentials: { token: 'tok' } as { token: string } | null } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => auth.value }));
const resume = vi.hoisted(() => new Set<() => void>());
vi.mock('@/sync/sync', () => ({ sync: { onResume: (l: () => void) => { resume.add(l); return () => { resume.delete(l); }; } } }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://srv.test' }));

import { CHANGELOG_RELEASES, changelogCliNotices, changelogCliTarget, visibleChangelogReleases, whatsNewReleases, type ChangelogRelease } from './changelogRelease';
import { markChangelogRead, pendingChangelogCliTarget, pendingChangelogReleases, type ChangelogReadState } from './changelogPager';
import { isCliVersionBelow } from './cliUpdatePolicy';
import { resetChangelogReadStoreForTest } from './changelogReadStore';
import { resetOverlayQueueForTest } from './overlayQueue';
import { setEnteredByDeepLinkForTest } from './entryKind';
import { ChangelogNotice } from './ChangelogNotice';
import { MajorUpdateEntry } from './MajorUpdateEntry';
import { ServerFeaturesSync } from './ServerFeaturesSync';
import { ChangelogScreen } from '@/screens/changelog/ChangelogScreen';
import { getServerFeatures, parseServerFeatures, setServerFeatures } from '@/sync/serverFeatures';

const rel = (id: string, extra: Partial<ChangelogRelease> = {}): ChangelogRelease => ({
  id, date: '2026-11-25', titleKey: 'changelog.releases.oct21.title', summaryKey: 'changelog.releases.oct21.summary', itemKeys: [], ...extra,
});
const ON = ['f'];
const G = rel('g', { requiresFeature: 'f', cliVersion: '0.2.230' });
const NOW = [G, rel('b', { cliVersion: '0.2.229' }), rel('a')];
const LATER = [rel('d'), ...NOW];
const ids = (list: readonly ChangelogRelease[]) => list.map((r) => r.id);
const pending = (s: ChangelogReadState, list: readonly ChangelogRelease[], f: readonly string[] = []) => ids(pendingChangelogReleases(s, list, f));

describe('gated entry: read state', () => {
  it.each([['caught up', 'b'], ['behind', 'a'], ['no receipt', null], ['unknown receipt', 'gone']])('%s: hidden and not unread while off; reading the rest leaves it unread for later', (_n, seen) => {
    const start = { seen, read: [] };
    const off = pending(start, NOW);
    expect(off).not.toContain('g');
    const after = markChangelogRead(start, off, NOW);
    expect(pending(after, NOW)).toEqual([]);
    expect(pending(after, NOW, ON)).toEqual(['g']);
    const done = markChangelogRead(after, ['g'], NOW, ON);
    expect(done).toEqual({ seen: 'g', read: [] });
  });

  it.each([['b'], ['a'], [null], ['gone']])('a newer ordinary entry read while off (receipt %s) does not carry the gated one along', (seen) => {
    const start = { seen, read: [] };
    const off = pending(start, LATER);
    expect(off[0]).toBe('d');
    const after = markChangelogRead(start, off, LATER);
    expect(pending(after, LATER)).toEqual([]);
    expect(pending(after, LATER, ON)).toEqual(['g']);
    expect(markChangelogRead(after, ['g'], LATER, ON)).toEqual({ seen: 'd', read: [] });
  });

  it('a receipt that already names it stays valid', () => {
    expect(pending({ seen: 'g', read: [] }, LATER)).toEqual(['d']);
    expect(pending({ seen: 'g', read: [] }, NOW)).toEqual([]);
  });

  it('a fresh browser with the feature on is greeted with it', () => {
    expect(pending({ seen: null, read: [] }, NOW, ON)).toEqual(['g']);
  });
});

describe('the shipped entries', () => {
  const gated = CHANGELOG_RELEASES.filter((r) => r.requiresFeature);
  it('only the plugin entries (nov25h, nov25g) are gated, on plugins-v1; every other entry stays', () => {
    expect(gated.map((r) => [r.titleKey, r.requiresFeature])).toEqual([['changelog.releases.nov25h.title', PLUGIN_SERVER_FEATURE], ['changelog.releases.nov25g.title', PLUGIN_SERVER_FEATURE]]);
    expect(visibleChangelogReleases([])).toEqual(CHANGELOG_RELEASES.filter((r) => !gated.includes(r)));
    expect(visibleChangelogReleases([PLUGIN_SERVER_FEATURE])).toEqual(CHANGELOG_RELEASES);
  });

  it('the gated entries\u2019 CLI (0.2.231, 0.2.230) is recommended all the same', () => {
    const g = gated[1];
    expect(g.cliVersion).toBe('0.2.230');
    expect(isCliVersionBelow('0.2.229', '0.2.230')).toBe(true);
    expect(isCliVersionBelow('0.2.230', '0.2.230')).toBe(false);
    const target = changelogCliTarget(CHANGELOG_RELEASES)!.cliVersion!;
    expect(isCliVersionBelow(target, '0.2.230')).toBe(false);
    const m = (v: string) => ({ id: v, active: true, metadata: { happyCliVersion: v } });
    expect(changelogCliNotices([m('0.2.229'), m('0.2.230')], g).map((n) => [n.machineId, n.targetVersion])).toEqual([['0.2.229', '0.2.230']]);
    expect(changelogCliNotices([m('0.2.229')])[0].targetVersion).toBe(target);
    expect(gated[0].cliVersion).toBe('0.2.231');
    expect(pendingChangelogCliTarget({ seen: 'a', read: [] }, NOW)?.cliVersion).toBe('0.2.230');
  });

  it('/whats-new never picks a hidden release', () => {
    const highlights = [{ key: 'h', titleKey: 'changelog.releases.oct21.title', bodyKey: 'changelog.releases.oct21.title' }] as const;
    const list = [rel('g', { requiresFeature: 'f', featured: true, highlights }), rel('web', { date: '2026-11-24', featured: true, highlights })];
    expect(whatsNewReleases(visibleChangelogReleases([], list))?.web.id).toBe('web');
    expect(whatsNewReleases(visibleChangelogReleases(ON, list))?.web.id).toBe('g');
  });
});

describe('in the app', () => {
  let root: Root;
  let host: HTMLElement;
  const gatedAt = CHANGELOG_RELEASES.findIndex((r) => r.requiresFeature === PLUGIN_SERVER_FEATURE);
  const gatedCount = CHANGELOG_RELEASES.filter((r) => r.requiresFeature === PLUGIN_SERVER_FEATURE).length;
  const lastGated = gatedAt + gatedCount - 1;
  const below = CHANGELOG_RELEASES[lastGated + 1];
  const PLUGIN_NOTES = /nov25[gh]/;
  // Whatever ships above the plugin entries later is read already; only they are in question.
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    localStorage.setItem('vh.changelog.seen', below.id);
    localStorage.setItem('vh.changelog.read', JSON.stringify(ids(CHANGELOG_RELEASES.slice(0, gatedAt))));
    resetChangelogReadStoreForTest();
    setEnteredByDeepLinkForTest(false);
    setServerFeatures([]);
    auth.value = { credentials: { token: 'tok' } };
    machines.length = 0;
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); resetOverlayQueueForTest(); vi.unstubAllGlobals(); });
  const mount = async (...parts: Parameters<typeof createElement>[0][]) => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root.render(createElement(MemoryRouter, null, ...parts.map((p, key) => createElement(p, { key })))); });
  };
  const reply = (status: number, body: unknown) => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const entry = () => document.querySelector('.vh-major-entry');
  const card = () => document.querySelector('.wn-card');

  it.each([
    ['switch off', 200, { features: [] }],
    ['older server', 404, { error: 'not_found' }],
    ['server error', 500, {}],
    ['another shape', 200, { features: { 'plugins-v1': true } }],
  ])('%s: no badge, no notes, not on /changelog, receipt untouched', async (_n, status, body) => {
    reply(status, body);
    await mount(ServerFeaturesSync, ChangelogNotice, MajorUpdateEntry, ChangelogScreen);
    expect(entry()).toBeNull();
    expect(card()).toBeNull();
    expect(host.textContent).not.toMatch(PLUGIN_NOTES);
    expect(host.textContent).toContain(below.titleKey);
    expect(localStorage.getItem('vh.changelog.seen')).toBe(below.id);
  });

  it('a failed request reads as off, and is asked again on resume', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await mount(ServerFeaturesSync, MajorUpdateEntry);
    expect(entry()).toBeNull();
    const ok = reply(200, { features: ['plugins-v1'] });
    await act(async () => { for (const l of resume) l(); });
    expect(entry()).not.toBeNull();
    await act(async () => { for (const l of resume) l(); });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('switch on: unread, opens on its own, and acknowledging it sticks', async () => {
    const fetchMock = reply(200, { features: ['plugins-v1'] });
    await mount(ServerFeaturesSync, ChangelogNotice, MajorUpdateEntry, ChangelogScreen);
    expect(fetchMock.mock.calls[0][0]).toBe('https://srv.test/v1/features');
    expect(entry()?.getAttribute('aria-label')).toBe(`changelog.notesEntryLabel:{"count":${gatedCount}}`);
    expect(card()?.textContent).toMatch(PLUGIN_NOTES);
    expect(host.textContent).toContain('changelog.releases.nov25g.title');
    expect(host.textContent).toContain('changelog.releases.nov25h.title');
    act(() => (document.querySelector('.wn-done') as HTMLButtonElement).click());
    expect(entry()).toBeNull();
    expect(localStorage.getItem('vh.changelog.seen')).toBe(CHANGELOG_RELEASES[0].id);
  });

  it('the notes open for other entries while off still recommend the hidden entry’s CLI, and an entry arriving meanwhile stays unread', async () => {
    localStorage.setItem('vh.changelog.seen', CHANGELOG_RELEASES[lastGated + 2].id);
    resetChangelogReadStoreForTest();
    machines.push({ id: 'm', active: true, metadata: { happyCliVersion: '0.2.229' } });
    await mount(ChangelogNotice, MajorUpdateEntry);
    expect(card()?.textContent).toContain(below.titleKey);
    expect(card()?.textContent).not.toMatch(PLUGIN_NOTES);
    expect(card()?.querySelector('.wn-cli code')?.textContent).toContain('0.2.231');
    act(() => setServerFeatures(['plugins-v1']));
    act(() => (document.querySelector('.wn-done') as HTMLButtonElement).click());
    expect(entry()?.getAttribute('aria-label')).toBe(`changelog.notesEntryLabel:{"count":${gatedCount}}`);
    expect(localStorage.getItem('vh.changelog.seen')).toBe(below.id);
  });

  it('signing out drops the features', async () => {
    reply(200, { features: ['plugins-v1'] });
    await mount(ServerFeaturesSync);
    expect(getServerFeatures()).toEqual(['plugins-v1']);
    auth.value = { credentials: null };
    await act(async () => { root.render(createElement(MemoryRouter, null, createElement(ServerFeaturesSync, { key: 0 }))); });
    expect(getServerFeatures()).toEqual([]);
  });

  it('parses only the array form', async () => {
    await mount(MajorUpdateEntry);
    expect(parseServerFeatures({ features: ['a', 1] })).toEqual(['a']);
    expect(parseServerFeatures(null)).toEqual([]);
  });
});
