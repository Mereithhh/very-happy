import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Modal } from './ModalManager';
import type { ModalConfig, ModalContextValue } from './types';
import { useImeGuard, isImeGuardedEvent } from '@/utils/ime';
import './modal.css';

/**
 * Dismissal (backdrop click / Escape) must RESOLVE the pending promise, not
 * just unmount the card: `await Modal.confirm(...)` used to hang forever when
 * the user clicked outside, stranding whatever state the caller kept around it
 * (the ⌘W confirm's "a dialog is already open" flag, for one). Dismiss = cancel.
 */
function resolveDismissed(config: ModalConfig): void {
  if (config.type === 'confirm') Modal.resolveConfirm(config.id, false);
  else if (config.type === 'prompt') Modal.resolvePrompt(config.id, null);
}

const ModalContext = createContext<ModalContextValue | null>(null);

export function useModal(): ModalContextValue {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error('useModal must be used within ModalProvider');
  return ctx;
}

let idSeq = 0;
function nextId() {
  return `m${++idSeq}`;
}

export function ModalProvider({ children }: { children: ReactNode }) {
  const [modals, setModals] = useState<ModalConfig[]>([]);

  const showModal = useCallback((config: Omit<ModalConfig, 'id'>) => {
    const id = nextId();
    setModals((prev) => [...prev, { ...config, id } as ModalConfig]);
    return id;
  }, []);

  const hideModal = useCallback((id: string) => {
    setModals((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const hideAllModals = useCallback(() => setModals([]), []);

  // Resolves as cancel like every other dismissal path (no side effects inside
  // the state updater — StrictMode double-invokes those).
  const dismissTopModal = useCallback(() => {
    const top = modals[modals.length - 1];
    if (!top) return false;
    resolveDismissed(top);
    setModals((prev) => prev.filter((m) => m.id !== top.id));
    return true;
  }, [modals]);

  useEffect(() => {
    Modal.setFunctions(showModal, hideModal, hideAllModals);
  }, [showModal, hideModal, hideAllModals]);

  // Keyboard handling for the TOPMOST modal. Window-level and capture phase on
  // purpose: this dialog does not trap focus, so keystrokes still go to whatever
  // had it (usually xterm's hidden textarea) and Escape has to be intercepted
  // before the terminal swallows it. Matters most for keyboard-triggered dialogs
  // like the ⌘W close confirm: a chord you open with the keyboard must be
  // cancellable with the keyboard.
  //   Escape → dismiss (= cancel).
  //   Enter  → confirm, but ONLY for a NON-destructive confirm. Every
  //            destructive confirm in the app passes `destructive: true`; those
  //            must never be one stray Enter away from happening. `prompt` owns
  //            its own Enter inside the input, so it is excluded too.
  useEffect(() => {
    if (modals.length === 0) return;
    const top = modals[modals.length - 1];
    const onKeyDown = (e: KeyboardEvent) => {
      if (isImeGuardedEvent(e)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        resolveDismissed(top);
        hideModal(top.id);
        return;
      }
      if (e.key === 'Enter' && top.type === 'confirm' && !top.destructive) {
        e.preventDefault();
        e.stopPropagation();
        Modal.resolveConfirm(top.id, true);
        hideModal(top.id);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [modals, hideModal]);

  const value = useMemo<ModalContextValue>(
    () => ({ state: { modals }, showModal, hideModal, hideAllModals, dismissTopModal }),
    [modals, showModal, hideModal, hideAllModals, dismissTopModal],
  );

  return (
    <ModalContext.Provider value={value}>
      {children}
      {modals.length > 0 && (
        <div className="vh-modal-layer">
          {modals.map((m) => (
            <ModalCard
              key={m.id}
              config={m}
              onClose={() => hideModal(m.id)}
              onDismiss={() => {
                resolveDismissed(m);
                hideModal(m.id);
              }}
            />
          ))}
        </div>
      )}
    </ModalContext.Provider>
  );
}

function ModalCard({
  config,
  onClose,
  onDismiss,
}: {
  config: ModalConfig;
  /** Unmount only — used by the buttons, which resolve on their own. */
  onClose: () => void;
  /** Backdrop click = cancel: unmount AND resolve the pending promise. */
  onDismiss: () => void;
}) {
  const [promptValue, setPromptValue] = useState(
    config.type === 'prompt' ? config.defaultValue ?? '' : '',
  );
  const ime = useImeGuard();

  const close = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <div className="vh-modal-backdrop" onClick={onDismiss}>
      <div
        className="vh-modal-card"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        {'title' in config && <div className="vh-modal-title">{config.title}</div>}
        {'message' in config && config.message && (
          <div className="vh-modal-message">{config.message}</div>
        )}

        {config.type === 'prompt' && (config.multiline ? (
          <textarea
            className="vh-modal-input vh-modal-textarea"
            autoFocus
            rows={6}
            placeholder={config.placeholder}
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            // Multiline: Enter inserts a newline; confirm via the button.
          />
        ) : (
          <input
            className="vh-modal-input"
            autoFocus
            type={config.inputType === 'secure-text' ? 'password' : 'text'}
            placeholder={config.placeholder}
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            onKeyDown={(e) => {
              // IME guard: the keystroke that commits a CJK composition
              // (Enter/Space in the candidate window) must not confirm the modal.
              if (ime.isGuarded(e)) return;
              if (e.key === 'Enter') close(() => Modal.resolvePrompt(config.id, promptValue));
            }}
          />
        ))}

        <div className="vh-modal-actions">
          {config.type === 'alert' &&
            (config.buttons ?? [{ text: 'OK' }]).map((b, i) => (
              <button
                key={i}
                className={`vh-modal-btn ${b.style === 'destructive' ? 'is-danger' : b.style === 'cancel' ? 'is-cancel' : 'is-primary'}`}
                onClick={() => close(() => b.onPress?.())}
              >
                {b.text}
              </button>
            ))}

          {config.type === 'confirm' && (
            <>
              <button
                className="vh-modal-btn is-cancel"
                onClick={() => close(() => Modal.resolveConfirm(config.id, false))}
              >
                {config.cancelText ?? 'Cancel'}
              </button>
              <button
                className={`vh-modal-btn ${config.destructive ? 'is-danger' : 'is-primary'}`}
                onClick={() => close(() => Modal.resolveConfirm(config.id, true))}
              >
                {config.confirmText ?? 'OK'}
              </button>
            </>
          )}

          {config.type === 'prompt' && (
            <>
              <button
                className="vh-modal-btn is-cancel"
                onClick={() => close(() => Modal.resolvePrompt(config.id, null))}
              >
                {config.cancelText ?? 'Cancel'}
              </button>
              <button
                className="vh-modal-btn is-primary"
                onClick={() => close(() => Modal.resolvePrompt(config.id, promptValue))}
              >
                {config.confirmText ?? 'OK'}
              </button>
            </>
          )}

          {config.type === 'custom' && (
            <config.component {...(config.props ?? {})} onClose={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}
