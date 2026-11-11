// @vitest-environment happy-dom
// B-928 (user feedback): a long task-details dialog scrolled its title and ×
// away, and a click outside did nothing. Head/foot now stick; a click on the
// backdrop closes the dialog — not a drag that ends outside, not once the user
// typed something, not while a popup inside is open.
import { readFileSync } from 'node:fs';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isBackdropHit, isOutsideBox, hasOpenPopup } from './backdropDismiss';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('pure hit test', () => {
  const box = { left: 100, top: 100, right: 300, bottom: 300 };
  it('outside the box only', () => {
    expect(isOutsideBox(box, 50, 200)).toBe(true);
    expect(isOutsideBox(box, 200, 350)).toBe(true);
    expect(isOutsideBox(box, 200, 200)).toBe(false);
    expect(isOutsideBox(box, 100, 300)).toBe(false);
  });
  it('a hit needs the backdrop itself as target; dialog mode also needs the point outside the card', () => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ ...box, x: 100, y: 100, width: 200, height: 200, toJSON: () => ({}) });
    const child = document.createElement('span'); el.append(child);
    expect(isBackdropHit('wrapper', el, el, 200, 200)).toBe(true);
    expect(isBackdropHit('wrapper', el, child, 0, 0)).toBe(false);
    expect(isBackdropHit('dialog', el, el, 200, 200)).toBe(false); // the dialog's own padding
    expect(isBackdropHit('dialog', el, el, 20, 20)).toBe(true);
    expect(isBackdropHit('dialog', el, child, 20, 20)).toBe(false);
  });
});

describe('sticky head and foot (CSS contract)', () => {
  const css = strip(read('../styles/dialog.css'));
  it('the head sticks to the top of every non-flush card, over the card padding', () => {
    expect(css).toMatch(/:where\(\.vh-dialog:not\(\.vh-dialog--flush\)\) > \.vh-dialog-head \{[^}]*position: sticky;[^}]*top: calc\(-1 \* var\(--vh-dialog-pt\)\);[^}]*z-index: 2;[^}]*margin: calc\(-1 \* var\(--vh-dialog-pt\)\)[^}]*background: var\(--bg-1\)/);
  });
  it('the foot sticks to the bottom at every width (not only the phone sheet)', () => {
    const desktop = css.slice(0, css.indexOf('@media (max-width: 600px)'));
    expect(desktop).toMatch(/:where\(\.vh-dialog:not\(\.vh-dialog--flush\)\) > \.vh-dialog-foot \{[^}]*position: sticky;[^}]*bottom: calc\(-1 \* var\(--vh-dialog-pb\)\);[^}]*background: var\(--bg-1\)/);
  });
  it('the card padding is the variables the head/foot bleed over, phone included', () => {
    expect(css).toMatch(/\.vh-dialog \{[^}]*padding: var\(--vh-dialog-pt\) var\(--vh-dialog-pr\) var\(--vh-dialog-pb\) var\(--vh-dialog-pl\)/);
    const phone = css.slice(css.indexOf('@media (max-width: 600px)'));
    expect(phone).toMatch(/:root \.vh-dialog \{[^}]*--vh-dialog-pt: var\(--sp-4\);[^}]*--vh-dialog-pb: 0px;/);
    expect(phone).not.toMatch(/:root \.vh-dialog \{[^}]*\bpadding:/);
  });
  it('the teams form submit sticks at every width, on a full-width strip', () => {
    const teams = strip(read('../screens/teams/teams.css'));
    // top level (line start), not inside a media query
    expect(teams).toMatch(/\n\.teams-dialog > form > button:last-child \{[^}]*position: sticky;/);
    expect(teams).toMatch(/\n\.teams-dialog > form > button:last-child \{[^}]*box-shadow: 0 0 0 100vmax var\(--bg-1\);[^}]*clip-path: inset\(calc\(-1 \* var\(--sp-3\)\) -100vw calc\(-1 \* var\(--teams-submit-gap\)\)\);/);
    // a disabled submit stays opaque (opacity would show the body through the strip)
    expect(teams).toMatch(/\.teams-dialog > form > \.teams-primary:last-child:disabled \{[^}]*opacity: 1;/);
  });
  it('every wrapper backdrop goes through DialogBackdrop (no bare onClick close)', () => {
    for (const f of ['../modal/ModalProvider.tsx', '../screens/issues/IssueDialogs.tsx', '../screens/session/WorktreeSetupBanner.tsx',
      '../screens/sessions/ImportHistoryModal.tsx', '../screens/sessions/RenameModal.tsx', '../screens/session/HandoffDialog.tsx',
      '../screens/projects/ChangeTeamProjectModal.tsx', '../screens/sessions/AttachTmuxModal.tsx', '../screens/terminal/TmuxHelpModal.tsx',
      '../screens/sessions/NewTerminalModal.tsx', '../screens/projects/NewProjectDialog.tsx', '../screens/projects/MoveToProjectModal.tsx',
      '../screens/sessions/NewSessionModal.tsx', '../screens/board/TaskBoardScreen.tsx']) {
      const src = read(f);
      // Either <DialogBackdrop className= or useDialogBackdrop({ className:
      expect(src, f).toMatch(/(<DialogBackdrop className=|useDialogBackdrop\(\{[^}]*className:)/);
      expect(src, f).not.toMatch(/vh-dialog-overlay[^"`]*["`]\}? onClick=/);
    }
  });
});

describe('click outside (real components)', () => {
  let TeamDialog: typeof import('@/screens/teams/TeamDialog').TeamDialog;
  let DialogBackdrop: typeof import('./DialogBackdrop').DialogBackdrop;
  let root: Root;
  let host: HTMLElement;
  beforeAll(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open'); };
    ({ TeamDialog } = await import('@/screens/teams/TeamDialog'));
    ({ DialogBackdrop } = await import('./DialogBackdrop'));
  });
  afterEach(() => { act(() => root?.unmount()); host?.remove(); });
  const mount = (node: ReactNode) => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    act(() => root.render(node));
  };
  const press = (down: Element, up: Element, at: [number, number], downAt: [number, number] = at) => act(() => {
    down.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: downAt[0], clientY: downAt[1] }));
    up.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, clientX: at[0], clientY: at[1] }));
  });
  const type = (field: HTMLInputElement | HTMLTextAreaElement) => act(() => {
    field.value = 'draft';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const teamDialog = (onClose: () => void, children: ReactNode) => {
    mount(createElement(TeamDialog, { title: 'Task details', onClose, children }));
    const dialog = document.querySelector('dialog.teams-dialog') as HTMLDialogElement;
    dialog.getBoundingClientRect = () => ({ left: 100, top: 50, right: 700, bottom: 650, x: 100, y: 50, width: 600, height: 600, toJSON: () => ({}) });
    return dialog;
  };

  it('task details: a click on the ::backdrop closes it; a click in the card padding does not', () => {
    const onClose = vi.fn();
    const dialog = teamDialog(onClose, createElement('p', null, 'long result'));
    press(dialog, dialog, [400, 300]);
    expect(onClose).not.toHaveBeenCalled();
    press(dialog, dialog, [20, 20]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('task details: selecting text inside and releasing outside does not close', () => {
    const onClose = vi.fn();
    const dialog = teamDialog(onClose, createElement('p', null, 'long result'));
    const text = dialog.querySelector('p')!;
    // press on the text, release on the backdrop: click lands on the dialog
    press(text, dialog, [20, 20], [400, 300]);
    expect(onClose).not.toHaveBeenCalled();
    // and the reverse: press outside, release inside
    press(dialog, text, [400, 300], [20, 20]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a form dialog closes from the backdrop while untouched, never after an edit', () => {
    const onClose = vi.fn();
    const dialog = teamDialog(onClose, createElement('form', null, createElement('textarea', { name: 'goal' })));
    press(dialog, dialog, [20, 20]);
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    host.remove();
    const onClose2 = vi.fn();
    const edited = teamDialog(onClose2, createElement('form', null, createElement('textarea', { name: 'goal' })));
    type(edited.querySelector('textarea')!);
    press(edited, edited, [20, 20]);
    expect(onClose2).not.toHaveBeenCalled();
  });

  it('a choice made in a picker counts as an edit', () => {
    const onClose = vi.fn();
    const dialog = teamDialog(onClose, createElement('div', { role: 'listbox' }, createElement('div', { role: 'option' }, 'Codex')));
    act(() => (dialog.querySelector('[role="option"]') as HTMLElement).click());
    press(dialog, dialog, [20, 20]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('P1-1: preset and agent choice (explicit markDirty) count as edits', () => {
    const onClose = vi.fn();
    // Simulate preset button: clicking it should mark dirty via a hidden input that fires onInput
    const presetDialog = teamDialog(onClose, createElement('div', null,
      createElement('span', { role: 'button', tabIndex: 0, 'data-testid': 'preset-btn' }),
      createElement('input', { type: 'hidden', 'data-testid': 'preset-trigger' })
    ));
    const presetBtn = presetDialog.querySelector('[data-testid="preset-btn"]') as HTMLElement;
    const presetInput = presetDialog.querySelector('[data-testid="preset-trigger"]') as HTMLInputElement;
    act(() => {
      presetBtn.click();
      presetInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    press(presetDialog, presetDialog, [20, 20]);
    expect(onClose).not.toHaveBeenCalled();
    act(() => root.unmount()); host.remove();

    const onClose2 = vi.fn();
    // Simulate agent button: same pattern with hidden input
    const agentDialog = teamDialog(onClose2, createElement('div', null,
      createElement('button', { type: 'button', 'data-testid': 'agent-btn' }),
      createElement('input', { type: 'hidden', 'data-testid': 'agent-trigger' })
    ));
    const agentBtn = agentDialog.querySelector('[data-testid="agent-btn"]') as HTMLButtonElement;
    const agentInput = agentDialog.querySelector('[data-testid="agent-trigger"]') as HTMLInputElement;
    act(() => {
      agentBtn.click();
      agentInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    press(agentDialog, agentDialog, [20, 20]);
    expect(onClose2).not.toHaveBeenCalled();
  });

  it('P3: Picker Enter selection counts as an edit', () => {
    const onClose = vi.fn();
    const onChange = vi.fn();
    // A dialog with a select that fires onChange when an option is picked
    const select = createElement('select', { 'data-testid': 'my-select', onChange: (e: any) => onChange((e.target as HTMLSelectElement).value) },
      createElement('option', { value: 'a' }, 'Option A'),
      createElement('option', { value: 'b' }, 'Option B')
    );
    const dialog = teamDialog(onClose, select);
    const selectEl = dialog.querySelector('[data-testid="my-select"]') as HTMLSelectElement;
    act(() => {
      selectEl.value = 'b';
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('b');
    press(dialog, dialog, [20, 20]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a press that dismisses an open popup inside does not also close the dialog', () => {
    const onClose = vi.fn();
    const dialog = teamDialog(onClose, createElement('button', { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'true' }, 'Machine'));
    press(dialog, dialog, [20, 20]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Esc and × still close as before', () => {
    const onClose = vi.fn();
    const dialog = teamDialog(onClose, createElement('p', null, 'x'));
    act(() => { dialog.dispatchEvent(new Event('cancel', { cancelable: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => (dialog.querySelector('.vh-dialog-close') as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('wrapper backdrop: closes on a real backdrop click only; drag-out and edits keep it open; onClose undefined is inert', () => {
    const onClose = vi.fn();
    const card = (children?: ReactNode) => createElement('div', { className: 'vh-dialog', onClick: (e: { stopPropagation(): void }) => e.stopPropagation() }, createElement('p', null, 'body'), children);
    mount(createElement(DialogBackdrop, { className: 'vh-dialog-overlay', onClose, children: card(createElement('input', { name: 'n' })) }));
    const backdrop = document.querySelector('.vh-dialog-overlay')!;
    const text = backdrop.querySelector('p')!;
    press(text, backdrop, [5, 5]);
    expect(onClose).not.toHaveBeenCalled();
    press(backdrop, backdrop, [5, 5]);
    expect(onClose).toHaveBeenCalledTimes(1);
    type(backdrop.querySelector('input')!);
    press(backdrop, backdrop, [5, 5]);
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.unmount()); host.remove();
    mount(createElement(DialogBackdrop, { className: 'vh-dialog-overlay', onClose: undefined, children: card() }));
    const inert = document.querySelector('.vh-dialog-overlay')!;
    press(inert, inert, [5, 5]); // no throw, nothing to call
  });
});

describe('Radix family (DialogContent)', () => {
  let root: Root;
  let host: HTMLElement;
  afterEach(() => { act(() => root?.unmount()); host?.remove(); });
  const open = async (onOpenChange: (open: boolean) => void) => {
    const Dialog = await import('@radix-ui/react-dialog');
    const { DialogContent } = await import('./DialogContent');
    const { createRef } = await import('react');
    const contentRef = createRef<HTMLDivElement>();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    act(() => root.render(createElement(Dialog.Root, { open: true, onOpenChange },
      createElement(Dialog.Portal, null, createElement(Dialog.Overlay, { className: 'vh-dialog-overlay' }),
        createElement(DialogContent, { ref: contentRef, className: 'vh-dialog', 'aria-describedby': undefined },
          createElement(Dialog.Title, null, 'Commit'), createElement('textarea', { name: 'message' }))))));
    await act(async () => { await new Promise(r => setTimeout(r, 10)); }); // Radix arms its outside listener on the next tick
  };
  const pressOutside = () => act(() => {
    const overlay = document.querySelector('.vh-dialog-overlay')!;
    overlay.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
  });
  it('a press outside closes an untouched dialog', async () => {
    const onOpenChange = vi.fn();
    await open(onOpenChange);
    pressOutside();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it('after an edit a press outside keeps it open', async () => {
    const onOpenChange = vi.fn();
    await open(onOpenChange);
    const field = document.querySelector('textarea')!;
    act(() => { field.value = 'fix: typo'; field.dispatchEvent(new Event('input', { bubbles: true })); });
    pressOutside();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
  it('P1-2: when a dropdown inside is open, clicking outside closes only the dropdown, not the dialog', async () => {
    const onOpenChange = vi.fn();
    await open(onOpenChange);
    const dropdown = document.createElement('button');
    dropdown.setAttribute('aria-haspopup', 'listbox');
    dropdown.setAttribute('aria-expanded', 'true');
    document.querySelector('.vh-dialog')!.append(dropdown);
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    const root = document.querySelector('.vh-dialog');
    const popupOpen = hasOpenPopup(root!);
    expect(popupOpen, 'hasOpenPopup should be true after append').toBe(true);
    pressOutside();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
  it('every Radix dialog on the shared shell uses DialogContent', () => {
    for (const f of ['../screens/session/ShareDialog.tsx', '../screens/session/OperatorFiles.tsx', '../screens/session/OperatorGrant.tsx',
      '../screens/session/SessionInfoDialog.tsx', '../screens/session/git/GitActionDialog.tsx', '../screens/session/ClaudeRuntimeDialog.tsx',
      '../screens/projects/ProjectShareDialog.tsx', '../screens/terminal/TerminalShareDialog.tsx', '../components/modelConfig/ModelConfigEditor.tsx',
      '../screens/session/AccountUnavailableBanner.tsx', '../components/accounts/AddAccountDialog.tsx', '../screens/projects/ProjectOperateAll.tsx']) {
      const src = read(f);
      expect(src, f).toMatch(/<DialogContent className=/);
      expect(src, f).not.toContain('<Dialog.Content');
    }
  });
});
