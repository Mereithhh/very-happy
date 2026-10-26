// @vitest-environment happy-dom
// B-697 — a `?task=` deep-link dialog and the release notes must never stack:
// the Radix notes lock body pointer events, the native <dialog> above them
// inherits that lock, and the page could only be left with Esc.
import { act, createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OVERLAY_PRIORITY, currentOverlay, overlayHeldAbove, overlayHolder, requestOverlay, resetOverlayQueueForTest } from './overlayQueue';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/sync/storage', () => ({ useAllMachines: () => [] }));
vi.mock('@/ui', () => ({ useToast: () => ({ success: () => {}, error: () => {} }), useTheme: () => ({ theme: 'light' }) }));
vi.mock('@/screens/search/sessionSearchEvents', () => ({ openSessionSearch: () => {} }));

describe('overlay turns (pure)', () => {
  afterEach(() => resetOverlayQueueForTest());
  it('highest priority first, then the newest (B-831: a confirm over a dialog stacks on top)', () => {
    expect(overlayHolder([])).toBeNull();
    expect(overlayHolder([{ id: 'n', priority: 1, seq: 1 }, { id: 'd', priority: 2, seq: 2 }])).toBe('d');
    expect(overlayHolder([{ id: 'd', priority: 2, seq: 5 }, { id: 'n', priority: 1, seq: 9 }])).toBe('d');
    expect(overlayHolder([{ id: 'a', priority: 2, seq: 3 }, { id: 'b', priority: 2, seq: 2 }])).toBe('a');
  });
  it('B-831: held above — cards (notice level) stand down for a Modal.* / dialog or critical, not for nothing', () => {
    expect(overlayHeldAbove(OVERLAY_PRIORITY.notice, [])).toBe(false);
    expect(overlayHeldAbove(OVERLAY_PRIORITY.notice, [{ id: 'n', priority: 1, seq: 1 }])).toBe(false);
    expect(overlayHeldAbove(OVERLAY_PRIORITY.notice, [{ id: 'n', priority: 1, seq: 1 }, { id: 'm', priority: 2, seq: 2 }])).toBe(true);
    expect(overlayHeldAbove(OVERLAY_PRIORITY.interaction, [{ id: 'm', priority: 2, seq: 2 }])).toBe(false);
    expect(overlayHeldAbove(OVERLAY_PRIORITY.interaction, [{ id: 'm', priority: 2, seq: 2 }, { id: 'a', priority: 3, seq: 1 }])).toBe(true);
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
  it('B-830: critical (sign-in expiry) outranks a dialog and a notice, whoever came first', () => {
    const notice = requestOverlay('notes', OVERLAY_PRIORITY.notice);
    const dialog = requestOverlay('task', OVERLAY_PRIORITY.interaction);
    expect(overlayHeldAbove(OVERLAY_PRIORITY.interaction)).toBe(false);
    const auth = requestOverlay('auth', OVERLAY_PRIORITY.critical);
    expect(currentOverlay()).toBe('auth');
    expect(overlayHeldAbove(OVERLAY_PRIORITY.interaction)).toBe(true);
    // Raised while the expiry dialog is up: still waits.
    const later = requestOverlay('confirm', OVERLAY_PRIORITY.interaction);
    expect(currentOverlay()).toBe('auth');
    auth();
    expect(overlayHeldAbove(OVERLAY_PRIORITY.interaction)).toBe(false);
    expect(currentOverlay()).toBe('confirm');
    later();
    expect(currentOverlay()).toBe('task');
    dialog(); notice();
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
  it('B-830: open notes give way to a critical overlay, unread, and come back after', () => {
    localStorage.setItem('vh.changelog.seen', '2026-01-01-old');
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    render(false);
    expect(document.querySelector('.wn-card')).not.toBeNull();
    const seen = localStorage.getItem('vh.changelog.seen');
    let release = () => {};
    act(() => { release = requestOverlay('auth', OVERLAY_PRIORITY.critical); });
    expect(document.querySelector('.wn-card')).toBeNull();
    expect(document.body.style.pointerEvents).not.toBe('none');
    expect(localStorage.getItem('vh.changelog.seen')).toBe(seen);
    act(() => release());
    expect(document.querySelector('.wn-card')).not.toBeNull();
  });
  it('B-831: a Modal.alert raised over open notes is what you can click — the notes step aside unread and come back', async () => {
    localStorage.setItem('vh.changelog.seen', '2026-01-01-old');
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    const { ModalProvider } = await import('@/modal/ModalProvider');
    const { Modal } = await import('@/modal/ModalManager');
    act(() => root.render(createElement(MemoryRouter, null, createElement(ModalProvider, null, createElement(ChangelogNotice)))));
    expect(document.querySelector('.wn-card')).not.toBeNull();
    const seen = localStorage.getItem('vh.changelog.seen');
    let pressed = 0;
    act(() => Modal.alert('Machine connected', 'Welcome', [{ text: 'OK', onPress: () => { pressed += 1; } }]));
    expect(document.querySelector('.wn-card')).toBeNull();
    expect(document.querySelector('.vh-modal-card')).not.toBeNull();
    expect(document.body.style.pointerEvents).not.toBe('none');
    expect(localStorage.getItem('vh.changelog.seen')).toBe(seen);
    act(() => (document.querySelector('.vh-modal-card .vh-modal-btn') as HTMLButtonElement).click());
    expect(pressed).toBe(1);
    expect(document.querySelector('.vh-modal-card')).toBeNull();
    expect(document.querySelector('.wn-card')).not.toBeNull();
    expect(localStorage.getItem('vh.changelog.seen')).toBe(seen);
  });
  it('B-831: notes asked to open while a Modal.confirm is up wait for it', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    const { ModalProvider } = await import('@/modal/ModalProvider');
    const { Modal } = await import('@/modal/ModalManager');
    localStorage.setItem('vh.changelog.seen', '2026-01-01-old');
    act(() => root.render(createElement(MemoryRouter, null, createElement(ModalProvider, null))));
    let answer: boolean | undefined;
    act(() => { void Modal.confirm('Discard?').then((v) => { answer = v; }); });
    act(() => root.render(createElement(MemoryRouter, null, createElement(ModalProvider, null, createElement(ChangelogNotice)))));
    expect(document.querySelector('.vh-modal-card')).not.toBeNull();
    expect(document.querySelector('.wn-card')).toBeNull();
    await act(async () => (document.querySelector('.vh-modal-card .vh-modal-btn.is-primary') as HTMLButtonElement).click());
    expect(answer).toBe(true);
    expect(document.querySelector('.wn-card')).not.toBeNull();
  });
  it('B-831: a Modal.confirm raised over a TeamDialog stacks on top; the dialog hides and comes back', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    const { ModalProvider } = await import('@/modal/ModalProvider');
    const { Modal } = await import('@/modal/ModalManager');
    localStorage.setItem('vh.changelog.seen', '2026-10-21-current');
    act(() => root.render(createElement(MemoryRouter, null, createElement(ModalProvider, null,
      createElement(TeamDialog, { title: 'Task details', onClose: () => {}, children: createElement('p', null, 'task body') })))));
    const dialog = document.querySelector('dialog.teams-dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    let answer: boolean | undefined;
    act(() => { void Modal.confirm('Archive?').then((v) => { answer = v; }); });
    expect(dialog.open).toBe(false);
    expect(document.querySelector('.vh-modal-card')).not.toBeNull();
    await act(async () => (document.querySelector('.vh-modal-card .vh-modal-btn.is-cancel') as HTMLButtonElement).click());
    expect(answer).toBe(false);
    expect(dialog.open).toBe(true);
  });
  it('without a dialog the notes show at once (nothing else queued)', () => {
    localStorage.setItem('vh.changelog.seen', '2026-01-01-old');
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    render(false);
    expect(document.querySelector('.wn-card')).not.toBeNull();
  });
});
