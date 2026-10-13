// @vitest-environment happy-dom
/**
 * B-575 review 低5: a deep link must still land when the section renders
 * late (lazy route chunk / async group) — here 1.2s after navigation, past
 * the first second but inside the 2s retry window. Past the window it gives
 * up silently (no throw, no highlight).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealSettingWhenReady, SETTING_TARGET_CLASS } from './settingsReveal';

describe('revealSettingWhenReady (lazy section)', () => {
  let root: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
    root = document.createElement('div');
    document.body.append(root);
  });
  afterEach(() => {
    root.remove();
    vi.useRealTimers();
  });

  function renderLate(id: string, afterMs: number) {
    setTimeout(() => {
      root.innerHTML = `<div class="set-scroll" style="height:100px;overflow:auto"><div style="height:2000px"></div><div class="vh-item" data-setting-id="${id}">row</div></div>`;
    }, afterMs);
  }

  it('finds an anchor that renders 1.2s later, highlights and focuses it', () => {
    renderLate('notifications.quietHours', 1200);
    revealSettingWhenReady(root, 'notifications.quietHours');
    vi.advanceTimersByTime(1100);
    expect(root.querySelector(`.${SETTING_TARGET_CLASS}`)).toBeNull();
    vi.advanceTimersByTime(200);
    const el = root.querySelector<HTMLElement>('[data-setting-id="notifications.quietHours"]');
    expect(el?.classList.contains(SETTING_TARGET_CLASS)).toBe(true);
    expect(document.activeElement).toBe(el);
    vi.advanceTimersByTime(2000);
    expect(el?.classList.contains(SETTING_TARGET_CLASS)).toBe(false);
  });

  it('gives up silently after the 2s window', () => {
    renderLate('notifications.quietHours', 2600);
    expect(() => {
      revealSettingWhenReady(root, 'notifications.quietHours');
      vi.advanceTimersByTime(3000);
    }).not.toThrow();
    expect(root.querySelector(`.${SETTING_TARGET_CLASS}`)).toBeNull();
  });
});
