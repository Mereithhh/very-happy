/**
 * B-588 — one-time feature tips. Entry points register an anchor with
 * `useFeatureTipAnchor`; the single `FeatureTipHost` (AppLayout) shows at most
 * ONE tip app-wide, never in the first seconds after a load, never over the
 * composer, never while a menu or modal dialog is open. 「知道了」/close, or
 * using the entry itself, marks it seen (device-local, versioned).
 * Settings › Appearance › 「重置功能提示」 calls resetFeatureTips().
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { IS_MAC } from '@/app/appChord';
import {
  FEATURE_TIPS,
  FEATURE_TIP_AVOID_SELECTOR,
  FEATURE_TIP_STARTUP_MS,
  pickTip,
  placeTip,
  readSeen,
  peekShortcutLabel,
  tipTextKey,
  tipToken,
  writeSeen,
  type Box,
  type FeatureTipDef,
  type FeatureTipId,
} from './featureTipsModel';
import './featureTips.css';

function storageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// ---- module store: anchors + seen set ----
const anchors = new Map<FeatureTipId, Set<HTMLElement>>();
let seen: Set<string> | null = null;
let version = 0;
const listeners = new Set<() => void>();
function emit() {
  version++;
  for (const l of Array.from(listeners)) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
function seenSet(): Set<string> {
  if (!seen) seen = readSeen(storageOrNull());
  return seen;
}

function allSeen(): boolean {
  const seenNow = seenSet();
  return FEATURE_TIPS.every((d) => seenNow.has(tipToken(d)));
}

export function dismissFeatureTip(id: FeatureTipId): void {
  const def = FEATURE_TIPS.find((d) => d.id === id);
  if (!def) return;
  const next = new Set(seenSet());
  if (next.has(tipToken(def))) return;
  next.add(tipToken(def));
  seen = next;
  writeSeen(storageOrNull(), next);
  emit();
}

export function resetFeatureTips(): void {
  seen = new Set();
  writeSeen(storageOrNull(), seen);
  emit();
}

/** Register `ref.current` as the entry point of tip `id` while `enabled`. Using the entry marks the tip seen. */
export function useFeatureTipAnchor(
  id: FeatureTipId,
  ref: React.RefObject<HTMLElement | null>,
  enabled = true,
  opts: { dismissOnClick?: boolean } = {},
): void {
  const dismissOnClick = opts.dismissOnClick !== false;
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let set = anchors.get(id);
    if (!set) anchors.set(id, (set = new Set()));
    set.add(el);
    const used = () => dismissFeatureTip(id);
    if (dismissOnClick) el.addEventListener('click', used);
    emit();
    return () => {
      if (dismissOnClick) el.removeEventListener('click', used);
      set!.delete(el);
      emit();
    };
  }, [id, ref, enabled, dismissOnClick]);
}

// ---- host ----
const BLOCKING_OVERLAYS = '.vh-menu, [role="dialog"][aria-modal="true"], [role="alertdialog"], .sb-peek';
// The composer, the floating onboarding cards and (B-723) the session's
// offline / archived banner (`.mrb`, whose 「恢复」 sits right under the header
// anchors) — a tip never sits on or under them; with no room left it waits.
const AVOID_SELECTOR = FEATURE_TIP_AVOID_SELECTOR;

function toBox(r: DOMRect): Box {
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function visibleAnchor(id: FeatureTipId): HTMLElement | null {
  let best: { el: HTMLElement; top: number } | null = null;
  for (const el of Array.from(anchors.get(id) ?? [])) {
    if (!el.isConnected) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) continue;
    const hiddenByCss = typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    if (hiddenByCss) continue;
    // The newest occurrence (e.g. the latest turn's 「审阅全部」) is lowest on screen.
    if (!best || r.top > best.top) best = { el, top: r.top };
  }
  return best?.el ?? null;
}

function avoidBoxes(): Box[] {
  return Array.from(document.querySelectorAll<HTMLElement>(AVOID_SELECTOR)).map((n) => toBox(n.getBoundingClientRect()));
}

function coarsePointer(): boolean {
  try {
    return window.matchMedia?.('(pointer: coarse)').matches === true;
  } catch {
    return false;
  }
}

export function FeatureTipHost() {
  const { t } = useTranslation();
  useSyncExternalStore(subscribe, () => version);
  const allSeenNow = allSeen();
  const [tick, setTick] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; side: 'top' | 'bottom' } | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const lastHeight = useRef(140);

  // Re-evaluate on scroll / resize (next frame) and once a second (anchors
  // appear, the startup window ends, overlays close).
  useEffect(() => {
    let frame = 0;
    const bump = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setTick((n) => n + 1);
      });
    };
    // Nothing left to show → no timer at all (re-armed by subscribe on reset).
    if (allSeen()) return;
    const timer = window.setInterval(bump, 1000);
    window.addEventListener('scroll', bump, { capture: true, passive: true });
    window.addEventListener('resize', bump);
    return () => {
      window.clearInterval(timer);
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', bump, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', bump);
    };
  }, [allSeenNow]);

  let tip: FeatureTipDef | null = null;
  let anchor: HTMLElement | null = null;
  const ready = typeof performance !== 'undefined' && performance.now() >= FEATURE_TIP_STARTUP_MS;
  if (ready && anchors.size > 0 && !document.querySelector(BLOCKING_OVERLAYS)) {
    // First unseen tip (in order) whose anchor is on screen AND that has room
    // next to it — a tip that cannot be placed must not block the next one.
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const avoid = avoidBoxes();
    const estimate = { width: Math.min(280, viewport.width - 16), height: lastHeight.current };
    const seenNow = seenSet();
    for (const def of FEATURE_TIPS) {
      if (!pickTip([def], seenNow, new Set([def.id]))) continue;
      const el = visibleAnchor(def.id);
      if (!el || !placeTip(toBox(el.getBoundingClientRect()), estimate, viewport, avoid)) continue;
      tip = def;
      anchor = el;
      break;
    }
  }

  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!tip || !anchor || !el) {
      if (pos) setPos(null);
      return;
    }
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    lastHeight.current = size.height;
    const next = placeTip(toBox(anchor.getBoundingClientRect()), size, { width: window.innerWidth, height: window.innerHeight }, avoidBoxes());
    if (next?.left !== pos?.left || next?.top !== pos?.top || next?.side !== pos?.side) setPos(next);
  });

  void tick;
  if (!tip || !anchor) return null;
  const id = tip.id;
  const textKey = tipTextKey(id, { coarse: coarsePointer(), compactNav: anchor.classList.contains('cl-promptnav') });
  return createPortal(
    <div
      ref={tipRef}
      className="vh-tip"
      // Not a dialog: `[role="dialog"]` is the terminal's "an overlay is open"
      // signal (termFocusOwnership.OVERLAY_SELECTOR) and would disable its
      // focus watchdog for as long as a passive hint is on screen.
      role="region"
      aria-labelledby="vh-tip-text"
      data-tip={id}
      data-side={pos?.side}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      <p id="vh-tip-text" className="vh-tip-text">{textKey === 'featureTips.sessionPeekHover' ? t(textKey, { keys: peekShortcutLabel(IS_MAC) }) : t(textKey)}</p>
      <div className="vh-tip-actions">
        <button type="button" className="vh-tip-ok" onClick={() => dismissFeatureTip(id)}>
          {t('featureTips.gotIt')}
        </button>
      </div>
      <button type="button" className="vh-tip-close" aria-label={t('featureTips.close')} onClick={() => dismissFeatureTip(id)}>
        <X size={14} />
      </button>
    </div>,
    document.body,
  );
}
