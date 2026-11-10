// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { jumpBlocker, lastTypingAt, leavesPage, trackTyping, typingHoldMs, userIsBusy } from './previewInterrupt';

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

  it('B-918: the jump checks visibility, typing and blockers before navigating; non-jump pushes open here', () => {
    const src = readFileSync(join(process.cwd(), 'src/screens/files/FsPreviewOverlay.tsx'), 'utf8');
    const hidden = src.indexOf("if (document.visibilityState === 'hidden') {");
    const typing = src.indexOf('const wait = typingHoldMs(Date.now(), lastTypingAt(), arrivedAt);');
    const guard = src.indexOf('if (jumpBlocker(document)) {');
    const held = src.indexOf("toast.action(t('filePreview.pushHeld', { name }),");
    const go = src.indexOf('go(next, key);', held);
    expect(hidden).toBeGreaterThan(0);
    expect(typing).toBeGreaterThan(hidden);
    expect(guard).toBeGreaterThan(typing);
    expect(held).toBeGreaterThan(guard);
    expect(go).toBeGreaterThan(held);
    // openHere never docks into another session's panel
    expect(src).toContain('previewDockTarget({ ...next, sessionId: undefined }, locationRef.current');
  });
});

describe('B-918: typing in A delays the jump, the composer does not block it', () => {
  it('waits for 2 s of quiet after the last key, capped at 10 s after arrival', () => {
    expect(typingHoldMs(10_000, null, 10_000)).toBe(0);
    expect(typingHoldMs(10_000, 7_000, 10_000)).toBe(0);         // last key 3 s ago
    expect(typingHoldMs(10_000, 9_500, 10_000)).toBe(1500);      // 0.5 s ago → 1.5 s more
    expect(typingHoldMs(19_000, 18_900, 10_000)).toBe(1000);     // still typing → cap at 20 s
    expect(typingHoldMs(20_000, 19_990, 10_000)).toBe(0);
  });

  it('records keystrokes into text fields only', () => {
    document.body.innerHTML = '<textarea id="t"></textarea><button id="b">x</button>';
    let now = 1000;
    const off = trackTyping(document, () => now);
    const before = lastTypingAt();
    document.getElementById('b')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(lastTypingAt()).toBe(before);
    now = 4242;
    document.getElementById('t')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(lastTypingAt()).toBe(4242);
    off();
  });

  it('the composer with a draft does not block (its draft is kept); a dialog or another unsaved field does', () => {
    document.body.innerHTML = '<textarea class="ci-textarea" id="c"></textarea><input id="i" type="text">';
    const c = document.getElementById('c') as HTMLTextAreaElement;
    c.value = '写到一半'; c.focus();
    expect(jumpBlocker(document)).toBeNull();
    const i = document.getElementById('i') as HTMLInputElement;
    i.value = 'x'; i.focus();
    expect(jumpBlocker(document)).toBe('notice');
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog"></div>');
    c.focus();
    expect(jumpBlocker(document)).toBe('notice');
  });
});
