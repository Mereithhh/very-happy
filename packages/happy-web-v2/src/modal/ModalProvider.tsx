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
import './modal.css';

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

  const dismissTopModal = useCallback(() => {
    let dismissed = false;
    setModals((prev) => {
      if (prev.length === 0) return prev;
      dismissed = true;
      return prev.slice(0, -1);
    });
    return dismissed;
  }, []);

  useEffect(() => {
    Modal.setFunctions(showModal, hideModal, hideAllModals);
  }, [showModal, hideModal, hideAllModals]);

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
            <ModalCard key={m.id} config={m} onClose={() => hideModal(m.id)} />
          ))}
        </div>
      )}
    </ModalContext.Provider>
  );
}

function ModalCard({ config, onClose }: { config: ModalConfig; onClose: () => void }) {
  const [promptValue, setPromptValue] = useState(
    config.type === 'prompt' ? config.defaultValue ?? '' : '',
  );

  const close = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <div className="vh-modal-backdrop" onClick={onClose}>
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

        {config.type === 'prompt' && (
          <input
            className="vh-modal-input"
            autoFocus
            type={config.inputType === 'secure-text' ? 'password' : 'text'}
            placeholder={config.placeholder}
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') close(() => Modal.resolvePrompt(config.id, promptValue));
            }}
          />
        )}

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
