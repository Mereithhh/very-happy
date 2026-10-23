/**
 * B-588 — lightweight one-time feature tips: which tip may show, where, and
 * what has been seen. Pure (storage is injected) so it is unit-tested.
 * Spec: specs/2026-10-small-ux-polish.md §3.
 *
 * Gate ideas from Orca `components/feature-tips/feature-tip-startup-gate.ts`
 * (ordered unseen tips, suppressed at startup; MIT). Implementation is ours —
 * an anchored hint instead of Orca's modal.
 */

/** device-local memory of dismissed tips, entries are `id@version` */
export const FEATURE_TIPS_SEEN_STORAGE = 'vh.featureTips.seen.v1';
/** nothing pops up during the first seconds after a load */
export const FEATURE_TIP_STARTUP_MS = 3000;
/** Boxes a tip must not cover: the composer, the floating onboarding cards and
 *  the session restore banner (`.mrb`, B-723 — its 「恢复」 button must stay clickable). */
export const FEATURE_TIP_AVOID_SELECTOR = '.sd-foot, .pwa-install, .notif-optin, .cli-update, .mrb';

export type FeatureTipId = 'quick-open' | 'prompt-rail' | 'review-all' | 'session-peek';

export interface FeatureTipDef {
  id: FeatureTipId;
  /** bump to show a reworked feature's tip again */
  version: number;
}

/** Display order: the first unseen tip with a visible anchor wins. */
export const FEATURE_TIPS: readonly FeatureTipDef[] = [
  { id: 'quick-open', version: 1 }, // B-576 ⌘P
  { id: 'prompt-rail', version: 1 }, // B-579
  { id: 'review-all', version: 1 }, // B-572
  { id: 'session-peek', version: 1 }, // B-588
];

export function tipToken(def: FeatureTipDef): string {
  return `${def.id}@${def.version}`;
}

type ReadStore = { getItem(key: string): string | null } | null | undefined;
type WriteStore = { setItem(key: string, value: string): void; removeItem(key: string): void } | null | undefined;

export function readSeen(store: ReadStore): Set<string> {
  try {
    const raw = store?.getItem(FEATURE_TIPS_SEEN_STORAGE);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Best effort: storage may throw (private mode) — the tip then stays hidden for this page only. */
export function writeSeen(store: WriteStore, seen: ReadonlySet<string>): void {
  try {
    if (seen.size === 0) store?.removeItem(FEATURE_TIPS_SEEN_STORAGE);
    else store?.setItem(FEATURE_TIPS_SEEN_STORAGE, JSON.stringify(Array.from(seen)));
  } catch {
    /* storage unavailable */
  }
}

export function pickTip(
  defs: readonly FeatureTipDef[],
  seen: ReadonlySet<string>,
  visible: ReadonlySet<FeatureTipId>,
): FeatureTipDef | null {
  for (const def of defs) {
    if (!seen.has(tipToken(def)) && visible.has(def.id)) return def;
  }
  return null;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function intersects(a: Box, b: Box): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/**
 * Below the anchor, else above; horizontally aligned to the anchor's start and
 * clamped into the viewport. A side that leaves the viewport or overlaps any
 * `avoid` box (the composer) is rejected; both rejected → null (do not show).
 * `insetLeft` / `insetRight` (B-796b): side safe-area insets — the tip stays
 * between them (the iPhone Duo cover display draws a status column on the right).
 */
export function placeTip(
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number; insetLeft?: number; insetRight?: number },
  avoid: readonly Box[],
  gap = 8,
  margin = 8,
): { left: number; top: number; side: 'bottom' | 'top' } | null {
  const minLeft = (viewport.insetLeft ?? 0) + margin;
  const maxLeft = Math.max(minLeft, viewport.width - (viewport.insetRight ?? 0) - size.width - margin);
  const left = Math.min(Math.max(anchor.left, minLeft), maxLeft);
  const candidates: Array<{ top: number; side: 'bottom' | 'top' }> = [
    { top: anchor.top + anchor.height + gap, side: 'bottom' },
    { top: anchor.top - gap - size.height, side: 'top' },
  ];
  for (const c of candidates) {
    if (c.top < margin || c.top + size.height > viewport.height - margin) continue;
    const box = { left, top: c.top, width: size.width, height: size.height };
    if (avoid.some((a) => intersects(box, a))) continue;
    return { left, top: c.top, side: c.side };
  }
  return null;
}

export type FeatureTipTextKey =
  | 'featureTips.quickOpen'
  | 'featureTips.promptRail'
  | 'featureTips.promptNav'
  | 'featureTips.reviewAll'
  | 'featureTips.sessionPeekHover'
  | 'featureTips.sessionPeekMenu';

/** Which translation key a tip shows. `coarse`: touch pointer; `compactNav`:
 *  the prompt rail's phone form (prev/next buttons instead of the tick rail). */
/** Alt+Enter as the platform writes it (⌥↩ on Apple keyboards). */
export function peekShortcutLabel(isMac: boolean): string {
  return isMac ? '⌥↩' : 'Alt+Enter';
}

export function tipTextKey(id: FeatureTipId, variant: { coarse: boolean; compactNav: boolean }): FeatureTipTextKey {
  switch (id) {
    case 'quick-open':
      return 'featureTips.quickOpen';
    case 'prompt-rail':
      return variant.compactNav ? 'featureTips.promptNav' : 'featureTips.promptRail';
    case 'review-all':
      return 'featureTips.reviewAll';
    case 'session-peek':
      return variant.coarse ? 'featureTips.sessionPeekMenu' : 'featureTips.sessionPeekHover';
  }
}
