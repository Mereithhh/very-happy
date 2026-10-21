import { t as translate } from '@/text';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
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

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="vh-toasts" role="region" aria-live="polite">
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
                className="vh-toast-x"
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
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
