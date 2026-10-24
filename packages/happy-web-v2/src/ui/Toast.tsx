import { t as translate } from '@/text';
import { createPortal } from 'react-dom';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

type ToastTone = 'success' | 'error' | 'info';

export function toastDurationMs(tone: ToastTone): number {
  // Success is usually lightweight feedback (especially copy actions).
  return tone === 'success' ? 1_800 : 4_000;
}

/** B-566: an explicit button next to the text ("已归档 · 撤销"). Unlike
 *  `onAction`, the toast body itself is not clickable. */
export interface ToastButton {
  label: string;
  onClick: () => void;
}

interface ToastOptions {
  /** run when the toast body is clicked (the toast dismisses after) —
   *  the click IS a user gesture, so clipboard writes are allowed inside */
  onAction?: () => void;
  /** don't auto-dismiss; renders an explicit ✕ to close without acting */
  sticky?: boolean;
  /** text + button layout; the button click dismisses the toast */
  button?: ToastButton;
  /** override the tone's default auto-dismiss delay */
  durationMs?: number;
}

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  onAction?: () => void;
  sticky?: boolean;
  button?: ToastButton;
}

interface ToastApi {
  show: (message: string, tone?: ToastTone, opts?: ToastOptions) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  /** sticky, clickable toast — for actions that need a user gesture */
  action: (message: string, onAction: () => void) => void;
  /** B-566: "<message> · <label>" with a real button, auto-dismissed after
   *  `durationMs` (the caller's undo window). */
  undoable: (message: string, label: string, onClick: () => void, durationMs: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** The topmost open modal <dialog>, if any — everything outside it is inert. */
export function topModalDialog(doc: Document): HTMLElement | null {
  let all: NodeListOf<HTMLElement>;
  try { all = doc.querySelectorAll<HTMLElement>('dialog:modal'); } catch { return null; }
  return all.length ? all[all.length - 1] : null;
}

/** B-774 (QA5 O1): the open modal on top — a native modal <dialog> or the
 *  last portalled `role=dialog aria-modal` card. */
export function openModalDialog(doc: Document): HTMLElement | null {
  const native = topModalDialog(doc);
  if (native) return native;
  const cards = doc.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]');
  return cards.length ? cards[cards.length - 1] : null;
}

/**
 * B-774 (QA5 O1): phones stack toasts at the top — over a full-height
 * dialog's title and ✕ (新建团队). When the stack would overlap the dialog,
 * it moves to just below the dialog's header (`.vh-dialog-head`); a bottom
 * sheet leaves room above it, so the toast stays put there (moving it to the
 * bottom would cover the sheet's 取消/确定 instead). Returns the new top in px,
 * or null to keep the default.
 */
export function toastTopOverDialog(dialog: { top: number }, head: { bottom: number } | null, stack: { top: number; height: number }, gap = 8): number | null {
  if (stack.top + stack.height + gap <= dialog.top) return null;
  return Math.round((head ? head.bottom : dialog.top) + gap);
}

// module-level bridge so non-React code (data layer) can toast too
let externalShow: ToastApi['show'] | null = null;
export const toast: ToastApi = {
  show: (m, t, o) => externalShow?.(m, t, o),
  success: (m) => externalShow?.(m, 'success'),
  error: (m) => externalShow?.(m, 'error'),
  action: (m, onAction) => externalShow?.(m, 'info', { onAction, sticky: true }),
  undoable: (m, label, onClick, durationMs) => externalShow?.(m, 'info', { button: { label, onClick }, durationMs }),
};

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  // B-772: a native modal <dialog> (新建团队) sits in the top layer and makes
  // everything outside it inert, so a plain fixed toast is hidden and can't be
  // clicked. While toasts show, the region moves into the topmost modal dialog
  // and is re-shown as a manual popover (top layer, viewport-positioned).
  const regionRef = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [belowHead, setBelowHead] = useState<number | null>(null);
  // the stack's own top before any shift (env(safe-area-inset-top) + gap), measured unshifted
  const defaultTop = useRef<number | null>(null);
  const hasItems = items.length > 0;
  const placeRef = useRef<() => void>(() => {});
  placeRef.current = () => {
    const region = regionRef.current;
    const dialog = openModalDialog(document);
    const phone = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 600px), (pointer: coarse)').matches;
    if (!region || !dialog || !phone) { setBelowHead(null); return; }
    const rect = region.getBoundingClientRect();
    if (belowHead === null || defaultTop.current === null) defaultTop.current = rect.top;
    const head = dialog.querySelector('.vh-dialog-head')?.getBoundingClientRect() ?? null;
    setBelowHead(toastTopOverDialog(dialog.getBoundingClientRect(), head, { top: defaultTop.current, height: rect.height }));
  };
  useEffect(() => {
    if (!hasItems || typeof document === 'undefined') { setHost(null); setBelowHead(null); return; }
    const pick = () => { setHost(topModalDialog(document)); placeRef.current(); };
    pick();
    // a sheet / dialog animates in: measure again once it has settled
    const settle = window.setTimeout(pick, 300);
    const observer = new MutationObserver(pick);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-modal'] });
    window.addEventListener('resize', pick);
    return () => { observer.disconnect(); window.clearTimeout(settle); window.removeEventListener('resize', pick); };
  }, [hasItems]);
  useEffect(() => {
    const region = regionRef.current;
    if (!region || typeof region.showPopover !== 'function') return;
    try {
      if (region.matches(':popover-open')) region.hidePopover();
      if (items.length > 0) region.showPopover();
    } catch { /* not connected yet / unsupported: stays a plain fixed layer */ }
    if (items.length > 0) placeRef.current(); // the stack's height changed
  }, [items, host]);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
    const tm = timers.current.get(id);
    if (tm) {
      clearTimeout(tm);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (message: string, tone: ToastTone = 'info', opts?: ToastOptions) => {
      const id = ++seq;
      setItems((prev) => [...prev, { id, tone, message, onAction: opts?.onAction, sticky: opts?.sticky, button: opts?.button }]);
      if (!opts?.sticky) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), opts?.durationMs ?? toastDurationMs(tone)),
        );
      }
    },
    [dismiss],
  );

  useEffect(() => {
    externalShow = show;
    return () => {
      if (externalShow === show) externalShow = null;
    };
  }, [show]);

  // Stable identity on purpose: consumers put `toast` in effect deps, and a
  // fresh object every render (each toast add/expiry re-renders the provider)
  // would tear those effects down — e.g. disposing the assistant TTS player.
  const api: ToastApi = useMemo(
    () => ({
      show,
      success: (m) => show(m, 'success'),
      error: (m) => show(m, 'error'),
      action: (m, onAction) => show(m, 'info', { onAction, sticky: true }),
      undoable: (m, label, onClick, durationMs) => show(m, 'info', { button: { label, onClick }, durationMs }),
    }),
    [show],
  );

  const region = (
    <div
      ref={regionRef}
      className={`vh-toasts${belowHead !== null ? ' vh-toasts--below-dialog-head' : ''}`}
      style={belowHead !== null ? ({ '--vh-toast-top': `${belowHead}px` } as CSSProperties) : undefined}
      role="region"
      aria-live="polite"
      popover="manual"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className={`vh-toast vh-toast--${t.tone}${t.onAction ? ' vh-toast--action' : ''}${t.button ? ' vh-toast--button' : ''}`}
          onClick={() => {
            if (t.button) return; // only the explicit button acts
            t.onAction?.();
            dismiss(t.id);
          }}
        >
          {t.button ? <span className="vh-toast-text">{t.message}</span> : t.message}
          {t.button && (
            <button
              type="button"
              className="vh-toast-btn"
              onClick={(e) => {
                e.stopPropagation();
                t.button?.onClick();
                dismiss(t.id);
              }}
            >
              {t.button.label}
            </button>
          )}
          {t.sticky && (
            <button
              type="button"
              className="vh-toast-x vh-hit"
              aria-label={translate('common.close')}
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.id);
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {host ? createPortal(region, host) : region}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
