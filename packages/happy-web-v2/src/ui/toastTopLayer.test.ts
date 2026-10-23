// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openModalDialog, toastTopOverDialog, topModalDialog } from './Toast';

/**
 * B-772: a native modal <dialog> (新建团队) is in the top layer and makes the
 * rest of the page inert, so the 「…推送了预览，点击查看」 notice was hidden and
 * unclickable. Measured in Chromium: tmp/vh-b772/o1.mjs (elementFromPoint hits
 * the toast, the click navigates).
 */
describe('toasts stay visible and clickable over a modal dialog', () => {
  it('portals into the topmost modal dialog and re-shows as a manual popover', () => {
    const src = readFileSync(join(process.cwd(), 'src/ui/Toast.tsx'), 'utf8');
    expect(src).toMatch(/ref=\{regionRef\}\s+className=\{`vh-toasts[^`]*`\}[\s\S]{0,200}role="region"\s+aria-live="polite"\s+popover="manual"/);
    expect(src).toContain('{host ? createPortal(region, host) : region}');
    expect(src).toContain("if (items.length > 0) region.showPopover();");
    const css = readFileSync(join(process.cwd(), 'src/ui/ui.css'), 'utf8');
    expect(css).toMatch(/\.vh-toasts \{[^}]*inset: auto;[^}]*background: transparent;/);
  });

  it('topModalDialog: none open → null; a selector the engine rejects → null', () => {
    document.body.innerHTML = '<dialog></dialog>';
    expect(topModalDialog(document)).toBeNull();
    const broken = { querySelectorAll: () => { throw new SyntaxError(':modal'); } } as unknown as Document;
    expect(topModalDialog(broken)).toBeNull();
  });
});

/**
 * B-774 (QA5 O1): on phones the toast stack sits at the top — right over a
 * full-height dialog's title and ✕ (新建团队). It moves to just below the
 * dialog's header then; a bottom sheet leaves room above, so it stays put
 * (the bottom would cover the sheet's 取消/确定). Measured in Chromium 390 px:
 * tmp/vh-team-B-774/o1.mjs.
 */
describe('toasts over a dialog on phones (B-774)', () => {
  const stack = { top: 8, height: 56 };
  it('a full-height dialog: below its header', () => {
    expect(toastTopOverDialog({ top: 0 }, { bottom: 60 }, stack)).toBe(68);
    expect(toastTopOverDialog({ top: 0 }, null, stack)).toBe(8); // no header found: at the dialog's top edge
  });

  it('a bottom sheet or centred card with room above: unchanged', () => {
    expect(toastTopOverDialog({ top: 533 }, { bottom: 600 }, stack)).toBeNull();
    expect(toastTopOverDialog({ top: 72 }, { bottom: 130 }, stack)).toBeNull();
    expect(toastTopOverDialog({ top: 71 }, { bottom: 130 }, stack)).toBe(138);
  });

  it('openModalDialog finds a portalled aria-modal card, not a plain or non-modal one', () => {
    document.body.innerHTML = '<div role="dialog"></div><div role="dialog" aria-modal="false"></div>';
    expect(openModalDialog(document)).toBeNull();
    document.body.innerHTML = '<div id="a" role="dialog" aria-modal="true"></div><div id="b" role="alertdialog" aria-modal="true"></div>';
    expect(openModalDialog(document)?.id).toBe('b');
  });

  it('the phone rule places the stack at the measured top, after the default top', () => {
    const css = readFileSync(join(process.cwd(), 'src/ui/ui.css'), 'utf8');
    const phone = css.slice(css.indexOf('@media (max-width: 600px), (pointer: coarse) {\n  .vh-toasts {'));
    const top = phone.indexOf('top: calc(var(--sa-t)');
    const below = phone.search(/\.vh-toasts\.vh-toasts--below-dialog-head \{\s*top: var\(--vh-toast-top\);\s*\}/);
    expect(top).toBeGreaterThan(0);
    expect(below).toBeGreaterThan(top);
    expect(phone.slice(0, below).match(/^}/m)).toBeNull(); // same @media block
  });
});
