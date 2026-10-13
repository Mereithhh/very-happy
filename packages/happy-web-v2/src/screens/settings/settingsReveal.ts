/**
 * B-575 — land on a settings row from a search result / ⌘K deep link:
 * scroll ONLY the settings content's own scroller (never `scrollIntoView`,
 * which also scrolls ancestors — design-language, right-workspace tabs rule)
 * and give the row a short neutral (--bg-3) highlight.
 */

export const SETTING_TARGET_CLASS = 'is-setting-target';
export const SETTING_HIGHLIGHT_MS = 1600;
/** breathing room above the target once scrolled */
export const SETTING_REVEAL_MARGIN = 16;

/**
 * The container scrollTop that puts the target's top `margin` px below the
 * container's top, clamped to the scrollable range. Rects are viewport
 * coordinates (getBoundingClientRect).
 */
export function revealTop(input: {
  containerTop: number;
  containerScrollTop: number;
  containerClientHeight: number;
  containerScrollHeight: number;
  targetTop: number;
  margin?: number;
}): number {
  const margin = input.margin ?? SETTING_REVEAL_MARGIN;
  const wanted = input.containerScrollTop + (input.targetTop - input.containerTop) - margin;
  const max = Math.max(0, input.containerScrollHeight - input.containerClientHeight);
  return Math.min(Math.max(0, Math.round(wanted)), max);
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

/** Scroll + highlight + focus one anchor. Returns false when it isn't rendered (yet). */
export function revealSettingAnchor(root: ParentNode, id: string): boolean {
  const target = root.querySelector<HTMLElement>(`[data-setting-id="${cssEscape(id)}"]`);
  if (!target) return false;
  const scroller = target.closest<HTMLElement>('.set-scroll');
  if (scroller) {
    const top = revealTop({
      containerTop: scroller.getBoundingClientRect().top,
      containerScrollTop: scroller.scrollTop,
      containerClientHeight: scroller.clientHeight,
      containerScrollHeight: scroller.scrollHeight,
      targetTop: target.getBoundingClientRect().top,
    });
    scroller.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }
  target.classList.add(SETTING_TARGET_CLASS);
  const prev = Number(target.dataset.settingTargetTimer || 0);
  if (prev) window.clearTimeout(prev);
  target.dataset.settingTargetTimer = String(
    window.setTimeout(() => {
      target.classList.remove(SETTING_TARGET_CLASS);
      delete target.dataset.settingTargetTimer;
    }, SETTING_HIGHLIGHT_MS),
  );
  // Keyboard / screen-reader continuation point; never scrolls by itself.
  if (!target.matches('button, a, input, select, textarea, [tabindex]')) target.setAttribute('tabindex', '-1');
  try {
    target.focus({ preventScroll: true });
  } catch {
    /* focus is a nicety */
  }
  return true;
}

/**
 * Retry per animation frame until the anchor renders (lazy route chunk,
 * async groups) or `timeoutMs` passes. Returns a cancel function.
 */
export function revealSettingWhenReady(root: ParentNode, id: string, timeoutMs = 2000): () => void {
  const started = Date.now();
  let raf = 0;
  const tick = () => {
    if (revealSettingAnchor(root, id)) return;
    if (Date.now() - started > timeoutMs) return;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
