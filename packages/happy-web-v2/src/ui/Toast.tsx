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

interface ToastOptions {
  /** run when the toast body is clicked (the toast dismisses after) —
   *  the click IS a user gesture, so clipboard writes are allowed inside */
  onAction?: () => void;
  /** don't auto-dismiss; renders an explicit ✕ to close without acting */
  sticky?: boolean;
}

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  onAction?: () => void;
  sticky?: boolean;
}

interface ToastApi {
  show: (message: string, tone?: ToastTone, opts?: ToastOptions) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  /** sticky, clickable toast — for actions that need a user gesture */
  action: (message: string, onAction: () => void) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

// module-level bridge so non-React code (data layer) can toast too
let externalShow: ToastApi['show'] | null = null;
export const toast: ToastApi = {
  show: (m, t, o) => externalShow?.(m, t, o),
  success: (m) => externalShow?.(m, 'success'),
  error: (m) => externalShow?.(m, 'error'),
  action: (m, onAction) => externalShow?.(m, 'info', { onAction, sticky: true }),
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
      setItems((prev) => [...prev, { id, tone, message, onAction: opts?.onAction, sticky: opts?.sticky }]);
      if (!opts?.sticky) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), 4000),
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
            className={`vh-toast vh-toast--${t.tone}${t.onAction ? ' vh-toast--action' : ''}`}
            onClick={() => {
              t.onAction?.();
              dismiss(t.id);
            }}
          >
            {t.message}
            {t.sticky && (
              <button
                type="button"
                className="vh-toast-x"
                aria-label="dismiss"
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
