import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { OVERLAY_PRIORITY, useOverlayTurn } from "@/app/overlayQueue";
import { useWorkspaceCopy } from "./workspaceCopy";

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
    return () => node.close();
  }, [turn]);
  return <dialog ref={ref} className="teams-dialog" aria-label={title} onCancel={onClose}>
    <div className="teams-dialog-heading"><h2>{title}</h2><button autoFocus aria-label={c.close} onClick={onClose}><X size={20} /></button></div>
    {children}
  </dialog>;
}
