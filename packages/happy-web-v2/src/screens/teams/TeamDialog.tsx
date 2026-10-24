import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { OVERLAY_PRIORITY, useOverlayTurn } from "@/app/overlayQueue";
import { useWorkspaceCopy } from "./workspaceCopy";

const INITIAL_FIELD = ':scope > :not(.vh-dialog-head) :is(textarea, input:not([type="hidden"], [type="checkbox"], [type="radio"]), select):not(:disabled)';

/** Native modal for the Teams page (task details, delegate, start, archive). */
export function TeamDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const c = useWorkspaceCopy();
  // B-697: a native modal under a Radix one (the release notes) inherits its
  // body pointer-events lock — take turns instead of stacking.
  const turn = useOverlayTurn(true, OVERLAY_PRIORITY.interaction);
  useEffect(() => {
    const node = ref.current;
    if (!node || !turn) return;
    if (!node.open) node.showModal();
    // B-728 (UI-P1-03): showModal() focuses the first control — the × in the
    // head. Start on the first field instead (§6: default focus on the field
    // you'll use); on touch keep the keyboard closed and focus the dialog.
    const field = node.querySelector<HTMLElement>(INITIAL_FIELD);
    if (field && window.matchMedia?.('(pointer: fine)').matches) field.focus();
    else node.focus();
    return () => node.close();
  }, [turn]);
  return <dialog ref={ref} tabIndex={-1} className="vh-dialog vh-dialog--tall teams-dialog" role="dialog" aria-modal="true" aria-label={title} onCancel={onClose}>
    <div className="vh-dialog-head teams-dialog-heading"><h2 className="vh-dialog-title">{title}</h2><button type="button" className="vh-dialog-close" aria-label={c.close} onClick={onClose}><X size={18} /></button></div>
    {children}
  </dialog>;
}
