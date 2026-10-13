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

export type FeatureTipId = 'review-all' | 'settings-search' | 'session-peek';

export interface FeatureTipDef {
  id: FeatureTipId;
  /** bump to show a reworked feature's tip again */
  version: number;
}

/** Display order: the first unseen tip with a visible anchor wins. */
export const FEATURE_TIPS: readonly FeatureTipDef[] = [
  { id: 'review-all', version: 1 }, // B-572
  { id: 'settings-search', version: 1 }, // B-575 / B-580
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
 */
export function placeTip(
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  avoid: readonly Box[],
  gap = 8,
  margin = 8,
): { left: number; top: number; side: 'bottom' | 'top' } | null {
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const left = Math.min(Math.max(anchor.left, margin), maxLeft);
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

export function tipCopy(id: FeatureTipId, zh: boolean, coarse: boolean): string {
  switch (id) {
    case 'review-all':
      return zh ? '「审阅全部」在右侧一次看完这个会话所有未提交的改动，可逐个标记已看。' : 'Review all opens every uncommitted change of this session on the right; mark files as viewed as you go.';
    case 'settings-search':
      return zh ? '设置可以直接搜具体选项；在 ⌘K 里输入设置名也能直达。' : 'Settings now search individual options — or type a setting name in ⌘K to jump there.';
    case 'session-peek':
      return coarse
        ? (zh ? '会话菜单里的「预览」可以不进会话就看机器、模型和最近一轮。' : 'Use Preview in a session’s menu to see its machine, model and latest round without opening it.')
        : (zh ? '鼠标在会话上停一下就能预览机器、模型和最近一轮；Alt+Enter 也可以。' : 'Rest the pointer on a session to preview its machine, model and latest round — or press Alt+Enter.');
  }
}
