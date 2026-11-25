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
const toasts: string[] = [];
const toastApi = {
  success: () => {},
  error: () => {},
  show: (message: string) => { toasts.push(message); },
};
vi.mock('@/ui', () => ({ useToast: () => toastApi, useTheme: () => ({ resolved: 'light' }) }));
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
let ChangelogHintSlot: typeof import('./ChangelogHintSlot').ChangelogHintSlot;
let slotsMod: typeof import('./changelogHintSlots');
/** Which slots are "on screen" (no layout here). */
let onScreen: Set<string> = new Set(['session']);
let MajorUpdateEntry: typeof import('./MajorUpdateEntry').MajorUpdateEntry;
let store: typeof import('./changelogReadStore');
let entry: typeof import('./entryKind');
let root: Root;
let host: HTMLElement;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ ChangelogNotice } = await import('./ChangelogNotice'));
  ({ ChangelogHintSlot } = await import('./ChangelogHintSlot'));
  slotsMod = await import('./changelogHintSlots');
  slotsMod.setChangelogHintSlotVisibilityForTest((el) => onScreen.has(el.dataset.kind ?? ''));
  ({ MajorUpdateEntry } = await import('./MajorUpdateEntry'));
  store = await import('./changelogReadStore');
  entry = await import('./entryKind');
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('vh.changelog.seen', 'old');
  entry.setEnteredByDeepLinkForTest(false);
  store.resetChangelogReadStoreForTest();
  toasts.length = 0;
  setHidden(false);
  // Phone-like (sidebar off screen): the sidebar row stays visible beside the bar.
  onScreen = new Set(['session']);
});

let hidden = false;
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
const setHidden = (value: boolean) => { hidden = value; };
const showPage = (after = 0) => act(() => {
  if (after) vi.setSystemTime(Date.now() + after);
  hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
});
const hidePage = () => act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });

afterEach(async () => {
  act(() => root?.unmount());
  host?.remove();
  (await import('./overlayQueue')).resetOverlayQueueForTest();
});

const mount = () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(MemoryRouter, null,
    createElement('header', { className: 'ch' }),
    createElement(ChangelogHintSlot, { kind: 'session' }),
    createElement(ChangelogNotice),
    createElement('nav', { className: 'sidebar' }, createElement(ChangelogHintSlot, { kind: 'sidebar' }), createElement(MajorUpdateEntry)))));
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

  it('B-857: records when the notes close — read to the end or closed on the last page — not while paging', () => {
    mount();
    expect(store.changelogClosedAt()).toBeNull();
    expect(store.changelogVisit().open).toBe(true);
    act(() => button('changelog.next')!.click());
    act(() => button('changelog.next')!.click());
    expect(store.changelogClosedAt()).toBeNull();
    press('Escape');
    expect(card()).toBeNull();
    expect(store.changelogClosedAt()).toEqual(expect.any(Number));
    expect(store.changelogVisit().open).toBe(false);

    remount();
    expect(store.changelogClosedAt()).toBeNull();
    act(() => button('changelog.done')!.click());
    expect(card()).toBeNull();
    expect(store.changelogClosedAt()).toEqual(expect.any(Number));
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
    // B-842: both majors read, the minor page is left — the entry turns quiet instead of disappearing.
    const quiet = document.querySelector('.vh-major-entry') as HTMLButtonElement;
    expect(quiet.dataset.kind).toBe('minor');
    expect(quiet.getAttribute('aria-label')).toBe('changelog.notesEntryLabel:{"count":1}');
    act(() => button('changelog.doneAll')!.click());
    expect(document.querySelector('.vh-major-entry')).toBeNull();
  });
});

// B-842 (Owner 10-28 「刷新页面也没有收到通知」): a minor release held back by a
// deep link (a session page refreshed with `?panel=…` open) or by early typing
// was visible nowhere — the sidebar entry counted majors only.
describe('B-842 / B-976 every unread release has a way in: the bar', () => {
  const minorOnly = () => { localStorage.setItem('vh.changelog.seen', 'big-1'); localStorage.setItem('vh.changelog.read', JSON.stringify(['big-2'])); };
  const bar = () => document.querySelector('[data-testid="changelog-hint"]');
  // Phone-like by default (sidebar off screen) so the sidebar row stays visible beside the bar.
  beforeEach(() => { onScreen = new Set(['session']); });

  it('B-976 phone: a row right under the session title bar — in the layout, not over it', () => {
    minorOnly();
    entry.setEnteredByDeepLinkForTest(true);
    mount();
    const slot = bar()!.parentElement!;
    expect(slot.dataset.kind).toBe('session');
    expect(slot.previousElementSibling?.className).toBe('ch');
    expect(bar()!.closest('.wn-card, [role="dialog"]')).toBeNull();
  });

  it('B-976 desktop: in the sidebar, taking the place of its 「更新说明」 row (one row, not two); ✕ gives the row back', () => {
    onScreen = new Set(['sidebar', 'session']);
    minorOnly();
    entry.setEnteredByDeepLinkForTest(true);
    mount();
    expect(bar()!.parentElement!.dataset.kind).toBe('sidebar');
    expect(document.querySelectorAll('[data-testid="changelog-hint"]')).toHaveLength(1);
    expect(document.querySelector('.vh-major-entry')).toBeNull();
    act(() => (document.querySelector('.wn-hint-close') as HTMLButtonElement).click());
    expect(bar()).toBeNull();
    expect(document.querySelector('.vh-major-entry')).not.toBeNull();
  });

  it('B-976: no slot on screen — the bar waits instead of floating, and shows once a slot is', () => {
    onScreen = new Set();
    minorOnly();
    entry.setEnteredByDeepLinkForTest(true);
    mount();
    expect(bar()).toBeNull();
    onScreen = new Set(['session']);
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(bar()).not.toBeNull();
  });


  it('deep link + only a minor release unread: quiet sidebar entry and the bar, both open the notes; no toast', () => {
    minorOnly();
    entry.setEnteredByDeepLinkForTest(true);
    mount();
    expect(card()).toBeNull();
    const quiet = document.querySelector('.vh-major-entry') as HTMLButtonElement;
    expect(quiet.dataset.kind).toBe('minor');
    expect(bar()?.textContent).toContain('changelog.hint:{"count":1}');
    expect(toasts).toEqual([]);
    act(() => button('changelog.hintOpen')!.click());
    expect(title()).toBe('changelog.releases.small.title');
    expect(bar()).toBeNull();
    act(() => button('changelog.done')!.click());
    expect(bar()).toBeNull();
    expect(document.querySelector('.vh-major-entry')).toBeNull();
  });

  it('typing before the notes mounted: no pager and nothing takes focus, but the bar and the entry are there', async () => {
    const first = await import('./afterFirstScreen');
    first.resetAfterFirstScreenForTest(undefined, { interacted: true });
    const input = document.createElement('textarea');
    document.body.append(input);
    input.focus();
    try {
      minorOnly();
      mount();
      expect(card()).toBeNull();
      expect(bar()).not.toBeNull();
      expect(document.activeElement).toBe(input);
      act(() => button('changelog.notesEntryShort')!.click());
      expect(title()).toBe('changelog.releases.small.title');
    } finally {
      input.remove();
      first.resetAfterFirstScreenForTest();
    }
  });

  it('B-976: the bar stays — no timer — until the notes are read', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval'] });
    try {
      minorOnly();
      entry.setEnteredByDeepLinkForTest(true);
      mount();
      act(() => { vi.advanceTimersByTime(10 * 60_000); });
      expect(bar()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('B-976: ✕ closes it for this visit only — unread, the entry stays; the next load shows it again', () => {
    minorOnly();
    entry.setEnteredByDeepLinkForTest(true);
    mount();
    act(() => (document.querySelector('.wn-hint-close') as HTMLButtonElement).click());
    expect(bar()).toBeNull();
    expect(document.querySelector('.vh-major-entry')).not.toBeNull();
    act(() => root.unmount()); host.remove(); mount(); // route-gate remount, same visit
    expect(bar()).toBeNull();
    remount(); // a new page load
    expect(bar()).not.toBeNull();
  });

  it('B-976: read on another tab — the bar goes away with the last unread release', () => {
    minorOnly();
    entry.setEnteredByDeepLinkForTest(true);
    mount();
    expect(bar()).not.toBeNull();
    act(() => {
      localStorage.setItem('vh.changelog.seen', 'big-2');
      localStorage.removeItem('vh.changelog.read');
      window.dispatchEvent(new StorageEvent('storage', { key: 'vh.changelog.seen' }));
    });
    expect(bar()).toBeNull();
  });

  it('B-976: a newer shell waiting for a refresh owns the moment — the update prompt alone, the bar after', async () => {
    const update = await import('./pendingUpdate');
    minorOnly();
    entry.setEnteredByDeepLinkForTest(true);
    act(() => update.setPendingUpdate({ entry: 'index-new.js' }));
    try {
      mount();
      expect(bar()).toBeNull();
      act(() => update.setPendingUpdate(null));
      expect(bar()).not.toBeNull();
    } finally {
      update.setPendingUpdate(null);
    }
  });

  it('B-976: loaded in the background, nothing is decided until the page is shown — then the bar (deep link) or the pager', () => {
    minorOnly();
    entry.setEnteredByDeepLinkForTest(true);
    setHidden(true);
    mount();
    expect(bar()).toBeNull();
    expect(card()).toBeNull();
    expect(store.changelogAutoShownThisVisit()).toBe(false);
    showPage();
    expect(bar()).not.toBeNull();

    act(() => root.unmount()); host.remove();
    store.resetChangelogReadStoreForTest();
    entry.setEnteredByDeepLinkForTest(false);
    setHidden(true);
    mount();
    expect(card()).toBeNull();
    showPage();
    expect(title()).toBe('changelog.releases.small.title');
  });

  it('B-976: a bar closed with ✕ comes back after a long time in the background (a PWA that never reloads), not after a short switch', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      minorOnly();
      entry.setEnteredByDeepLinkForTest(true);
      mount();
      act(() => (document.querySelector('.wn-hint-close') as HTMLButtonElement).click());
      hidePage();
      showPage(60_000);
      expect(bar()).toBeNull();
      hidePage();
      showPage(31 * 60_000);
      expect(bar()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('B-976: the pager closed unread (Esc on the last page); back after a long time without a reload — the bar, not after a short switch', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      minorOnly();
      mount();
      expect(title()).toBe('changelog.releases.small.title');
      press('Escape');
      expect(card()).toBeNull();
      hidePage();
      showPage(60_000);
      expect(bar()).toBeNull();
      hidePage();
      showPage(31 * 60_000);
      expect(bar()).not.toBeNull();
      expect(card()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('B-976: returning to the page while the notes are open changes nothing — no bar behind the pager', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      minorOnly();
      mount();
      expect(card()).not.toBeNull();
      hidePage();
      showPage(31 * 60_000);
      expect(card()).not.toBeNull();
      expect(bar()).toBeNull();
      act(() => store.markChangelogReleasesRead([])); // a read-state change while open must not raise it either
      expect(bar()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('B-950: list → session → list (the notice remounts under the other route gate) keeps one bar', () => {
    minorOnly();
    entry.setEnteredByDeepLinkForTest(true);
    mount();
    const navigate = () => { act(() => root.unmount()); host.remove(); mount(); };
    navigate();
    navigate();
    expect(document.querySelectorAll('[data-testid="changelog-hint"]')).toHaveLength(1);
    expect(card()).toBeNull();
    act(() => button('changelog.notesEntryShort')!.click());
    expect(title()).toBe('changelog.releases.small.title');
  });

  it('B-950: the pager that opened on its own does not open again when the notice remounts in the same visit', () => {
    mount();
    expect(card()).not.toBeNull();
    act(() => root.unmount()); host.remove(); mount();
    expect(card()).toBeNull();
    expect(bar()).toBeNull();
  });

  it('an ordinary load opens the pager and shows no bar', () => {
    mount();
    expect(card()).not.toBeNull();
    expect(bar()).toBeNull();
  });

  it('nothing unread: no bar and no entry, even on a deep link', () => {
    localStorage.setItem('vh.changelog.seen', 'big-2');
    entry.setEnteredByDeepLinkForTest(true);
    mount();
    expect(card()).toBeNull();
    expect(bar()).toBeNull();
    expect(document.querySelector('.vh-major-entry')).toBeNull();
  });

  it('the bar steps aside while a dialog above `notice` holds the turn (a `?task=` deep link), and comes back', async () => {
    const queue = await import('./overlayQueue');
    const release = queue.requestOverlay('team-dialog', queue.OVERLAY_PRIORITY.interaction);
    minorOnly();
    entry.setEnteredByDeepLinkForTest(true);
    mount();
    expect(bar()).toBeNull();
    act(() => release());
    expect(bar()).not.toBeNull();
    let again = () => {};
    act(() => { again = queue.requestOverlay('again', queue.OVERLAY_PRIORITY.interaction); });
    expect(bar()).toBeNull();
    act(() => again());
    expect(bar()).not.toBeNull();
  });
});
