// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { leavesPage, userIsBusy } from './previewInterrupt';

afterEach(() => { document.body.innerHTML = ''; });

describe('B-772 (QA4 O1): a pushed preview never yanks you out of work in progress', () => {
  it('idle page → not busy', () => {
    document.body.innerHTML = '<main><textarea></textarea><input type="text"></main>';
    expect(userIsBusy(document)).toBe(false);
  });

  it('an open dialog or sheet (native, Radix, picker sheet) → busy', () => {
    for (const html of ['<dialog open><textarea></textarea></dialog>', '<div role="dialog"></div>', '<div role="alertdialog"></div>', '<div class="vh-picker-sheet"></div>']) {
      document.body.innerHTML = html;
      expect(userIsBusy(document), html).toBe(true);
    }
  });

  it('the preview overlay itself does not count (a newer push replaces it)', () => {
    document.body.innerHTML = '<div class="fpo-layer"><div class="fpo-panel" role="dialog"></div></div>';
    expect(userIsBusy(document)).toBe(false);
  });

  it('the focused field holds unsent text → busy; empty or unfocused → not', () => {
    document.body.innerHTML = '<textarea id="t"></textarea><input id="i" type="text"><input id="c" type="checkbox">';
    const t = document.getElementById('t') as HTMLTextAreaElement;
    t.focus();
    expect(userIsBusy(document)).toBe(false);
    t.value = '还没发出去';
    expect(userIsBusy(document)).toBe(true);
    (document.getElementById('c') as HTMLInputElement).focus();
    expect(userIsBusy(document)).toBe(false);
    const i = document.getElementById('i') as HTMLInputElement;
    i.value = 'draft'; i.focus();
    expect(userIsBusy(document)).toBe(true);
  });

  it('only a different page counts as leaving; docking the side panel here does not', () => {
    expect(leavesPage('/session/a?panel=browse&pinFile=x', '/session/a')).toBe(false);
    expect(leavesPage('/session/a?panel=browse', '/teams')).toBe(true);
    expect(leavesPage('/session/a', '/')).toBe(true);
    expect(leavesPage(null, '/')).toBe(false);
  });

  it('the overlay checks it before docking or following, and holds the push behind a clickable notice', () => {
    const src = readFileSync(join(process.cwd(), 'src/screens/files/FsPreviewOverlay.tsx'), 'utf8');
    const guard = src.indexOf('if (next.fromPush && !held && leavesPage(target, locationRef.current.pathname) && userIsBusy(document)) {');
    expect(guard).toBeGreaterThan(0);
    expect(src.indexOf("toast.action(t('filePreview.pushHeld', { name }), () => show(next, true));")).toBeGreaterThan(guard);
    expect(src.indexOf('navigate(dock);')).toBeGreaterThan(guard);
    expect(src.indexOf('if (follow) navigate(follow);')).toBeGreaterThan(guard);
  });
});
