// @vitest-environment happy-dom
// B-697 — a `?task=` deep-link dialog and the release notes must never stack:
// the Radix notes lock body pointer events, the native <dialog> above them
// inherits that lock, and the page could only be left with Esc.
import { act, createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OVERLAY_PRIORITY, currentOverlay, overlayHolder, requestOverlay, resetOverlayQueueForTest } from './overlayQueue';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/sync/storage', () => ({ useAllMachines: () => [] }));
vi.mock('@/ui', () => ({ useToast: () => ({ success: () => {}, error: () => {} }), useTheme: () => ({ theme: 'light' }) }));
vi.mock('@/screens/search/sessionSearchEvents', () => ({ openSessionSearch: () => {} }));

describe('overlay turns (pure)', () => {
  afterEach(() => resetOverlayQueueForTest());
  it('highest priority first, then first come', () => {
    expect(overlayHolder([])).toBeNull();
    expect(overlayHolder([{ id: 'n', priority: 1, seq: 1 }, { id: 'd', priority: 2, seq: 2 }])).toBe('d');
    expect(overlayHolder([{ id: 'a', priority: 2, seq: 3 }, { id: 'b', priority: 2, seq: 2 }])).toBe('b');
  });
  it('a dialog pre-empts a notice already showing, and the notice gets its turn back on release', () => {
    const notice = requestOverlay('notes', OVERLAY_PRIORITY.notice);
    expect(currentOverlay()).toBe('notes');
    const dialog = requestOverlay('task', OVERLAY_PRIORITY.interaction);
    expect(currentOverlay()).toBe('task');
    dialog();
    expect(currentOverlay()).toBe('notes');
    notice();
    expect(currentOverlay()).toBeNull();
  });
});

describe('deep-link task dialog + unread release notes (real components)', () => {
  let ChangelogNotice: typeof import('./ChangelogNotice').ChangelogNotice;
  let TeamDialog: typeof import('@/screens/teams/TeamDialog').TeamDialog;
  let root: Root;
  let host: HTMLElement;
  beforeAll(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open'); };
    ({ ChangelogNotice } = await import('./ChangelogNotice'));
    ({ TeamDialog } = await import('@/screens/teams/TeamDialog'));
  });
  afterEach(() => { act(() => root?.unmount()); host?.remove(); resetOverlayQueueForTest(); });
  const render = (dialog: boolean) => act(() => root.render(createElement(MemoryRouter, null,
    createElement(ChangelogNotice),
    dialog ? createElement(TeamDialog, { title: 'Task details', onClose: () => {}, children: createElement('p', null, 'task body') }) : null)));
  it('shows the task dialog alone, unlocked; the notes follow once it closes', () => {
    localStorage.setItem('vh.changelog.seen', '2026-01-01-old');
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    render(true);
    const dialog = document.querySelector('dialog.teams-dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(document.querySelector('.wn-card')).toBeNull();
    expect(document.body.style.pointerEvents).not.toBe('none');
    render(false);
    expect(document.querySelector('.wn-card')).not.toBeNull();
  });
  it('without a dialog the notes show at once (nothing else queued)', () => {
    localStorage.setItem('vh.changelog.seen', '2026-01-01-old');
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    render(false);
    expect(document.querySelector('.wn-card')).not.toBeNull();
  });
});
