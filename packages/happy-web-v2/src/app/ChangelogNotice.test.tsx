// @vitest-environment happy-dom
// B-715 — stacked release notes are paged oldest → newest and cannot be
// dismissed before the last page; each finished page is recorded so a reload
// resumes; deep-link loads only show the sidebar entry (B-697 stays fixed).
import { act, createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangelogRelease } from './changelogRelease';

vi.mock('@/i18n/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) => (args ? `${key}:${JSON.stringify(args)}` : key),
    lang: 'en',
  }),
}));
vi.mock('@/sync/storage', () => ({ useAllMachines: () => [] }));
vi.mock('@/ui', () => ({ useToast: () => ({ success: () => {}, error: () => {} }), useTheme: () => ({ resolved: 'light' }) }));
vi.mock('@/screens/search/sessionSearchEvents', () => ({ openSessionSearch: () => {} }));

const rel = (id: string, block: string, major = false): ChangelogRelease => ({
  id,
  date: '2026-10-21',
  major,
  titleKey: `changelog.releases.${block}.title` as ChangelogRelease['titleKey'],
  summaryKey: `changelog.releases.${block}.summary` as ChangelogRelease['summaryKey'],
  itemKeys: [`changelog.releases.${block}.item` as ChangelogRelease['itemKeys'][number]],
});
// Newest first: 2 major + 1 minor unread above the receipt `old`.
const FAKE = [rel('big-2', 'big2', true), rel('small', 'small'), rel('big-1', 'big1', true), rel('old', 'old')];

vi.mock('./changelogRelease', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./changelogRelease')>();
  return { ...actual, CHANGELOG_RELEASES: FAKE, CURRENT_CHANGELOG: FAKE[0], changelogSeenValue: () => FAKE[0].id };
});

let ChangelogNotice: typeof import('./ChangelogNotice').ChangelogNotice;
let MajorUpdateEntry: typeof import('./MajorUpdateEntry').MajorUpdateEntry;
let store: typeof import('./changelogReadStore');
let entry: typeof import('./entryKind');
let root: Root;
let host: HTMLElement;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ ChangelogNotice } = await import('./ChangelogNotice'));
  ({ MajorUpdateEntry } = await import('./MajorUpdateEntry'));
  store = await import('./changelogReadStore');
  entry = await import('./entryKind');
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('vh.changelog.seen', 'old');
  entry.setEnteredByDeepLinkForTest(false);
  store.resetChangelogReadStoreForTest();
});

afterEach(async () => {
  act(() => root?.unmount());
  host?.remove();
  (await import('./overlayQueue')).resetOverlayQueueForTest();
});

const mount = () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(MemoryRouter, null, createElement(ChangelogNotice), createElement(MajorUpdateEntry))));
};
const remount = () => {
  act(() => root.unmount());
  host.remove();
  store.resetChangelogReadStoreForTest(); // a reload re-reads localStorage
  mount();
};
const card = () => document.querySelector('.wn-card');
const title = () => card()?.querySelector('h2')?.textContent;
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
const press = (key: string) => act(() => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
const clickBackdrop = () => act(() => {
  const backdrop = document.querySelector('.wn-backdrop') ?? document.body;
  backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});

describe('B-715 release-notes pager', () => {
  it('pages oldest → newest with progress; ✕, Esc and the backdrop cannot close it before the last page', () => {
    mount();
    expect(title()).toBe('changelog.releases.big1.title');
    expect(card()?.textContent).toContain('changelog.pageProgress:{"current":1,"total":3}');
    expect(card()?.querySelector('[aria-live]')?.textContent).toBe('changelog.pageProgressLabel:{"current":1,"total":3}');
    expect(card()?.querySelector('.vh-major-badge')).not.toBeNull();
    expect(card()?.querySelector('.wn-close')).toBeNull();
    press('Escape');
    clickBackdrop();
    expect(card()).not.toBeNull();

    act(() => button('changelog.next')!.click());
    expect(title()).toBe('changelog.releases.big2.title');
    expect(card()?.querySelector('.wn-close')).toBeNull();
    press('Escape');
    expect(card()).not.toBeNull();

    act(() => button('changelog.next')!.click());
    // The minor release shares the last page; now it may close.
    expect(title()).toBe('changelog.minorPageTitle');
    expect(card()?.textContent).toContain('changelog.releases.small.title');
    expect(card()?.querySelector('.wn-close')).not.toBeNull();
    expect(button('changelog.next')).toBeUndefined();
    act(() => button('changelog.doneAll')!.click());
    expect(card()).toBeNull();
    expect(localStorage.getItem('vh.changelog.seen')).toBe('big-2');
    expect(localStorage.getItem('vh.changelog.read')).toBeNull();
  });

  it('a reload mid-way resumes at the first unread page', () => {
    mount();
    act(() => button('changelog.next')!.click()); // big-1 read: directly above the receipt, so the receipt moves
    expect(localStorage.getItem('vh.changelog.seen')).toBe('big-1');
    act(() => button('changelog.next')!.click()); // big-2 read: `small` below it is unread, so it waits in the set
    expect(JSON.parse(localStorage.getItem('vh.changelog.read')!)).toEqual(['big-2']);
    remount();
    expect(title()).toBe('changelog.releases.small.title');
    expect(card()?.querySelector('.wn-progress')).toBeNull();
  });

  it('a reload right after the first page resumes at the second', () => {
    mount();
    act(() => button('changelog.next')!.click());
    remount();
    expect(title()).toBe('changelog.releases.big2.title');
    expect(card()?.textContent).toContain('changelog.pageProgress:{"current":1,"total":2}');
  });

  it('on the last page Esc closes without writing the receipt (B-315); earlier pages stay read', () => {
    mount();
    act(() => button('changelog.next')!.click());
    act(() => button('changelog.next')!.click());
    press('Escape');
    expect(card()).toBeNull();
    remount();
    // Only the minor release is left: a single ordinary page, closable at once.
    expect(title()).toBe('changelog.releases.small.title');
    expect(card()?.querySelector('.wn-progress')).toBeNull();
    expect(card()?.querySelector('.wn-close')).not.toBeNull();
  });

  it('a deep-link load does not open the notes; the sidebar entry is there and opens them', () => {
    entry.setEnteredByDeepLinkForTest(true);
    mount();
    expect(card()).toBeNull();
    expect(document.body.style.pointerEvents).not.toBe('none');
    const entryButton = document.querySelector('.vh-major-entry') as HTMLButtonElement;
    expect(entryButton.getAttribute('aria-label')).toBe('changelog.entryLabel:{"count":2}');
    act(() => entryButton.click());
    expect(title()).toBe('changelog.releases.big1.title');
  });

  it('B-823: deferred past the first screen, it does not open on its own once the person started typing/tapping', async () => {
    const first = await import('./afterFirstScreen');
    first.resetAfterFirstScreenForTest(undefined, { interacted: true });
    try {
      mount();
      expect(card()).toBeNull();
      // Still reachable from the sidebar entry, unread.
      act(() => button('changelog.entryShort')!.click());
      expect(title()).toBe('changelog.releases.big1.title');
    } finally {
      first.resetAfterFirstScreenForTest();
    }
  });

  it('the sidebar entry counts unread majors and disappears once they are read', () => {
    entry.setEnteredByDeepLinkForTest(true);
    mount();
    act(() => (document.querySelector('.vh-major-entry') as HTMLButtonElement).click());
    act(() => button('changelog.next')!.click());
    expect(document.querySelector('.vh-major-entry')?.getAttribute('aria-label')).toBe('changelog.entryLabel:{"count":1}');
    act(() => button('changelog.next')!.click());
    // Both majors read; only the minor page is left — the entry is gone.
    expect(document.querySelector('.vh-major-entry')).toBeNull();
  });
});
