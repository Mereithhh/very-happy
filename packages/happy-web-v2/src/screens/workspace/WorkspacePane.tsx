import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { RecoverableBoundary } from '@/ui/RecoverableBoundary';

/** Keep subtree state while restoring nested scroll surfaces after hide/reorder.
 *  B-565: every workspace tab panel is its own render-error boundary. */
export function WorkspacePane({ active, order, children, className }: { active: boolean; order: string; children: ReactNode; className?: string }) {
  const positions = useRef(new Map<HTMLElement, { top: number; left: number }>());
  useLayoutEffect(() => {
    if (active) for (const [element, position] of positions.current) {
      element.scrollTop = position.top;
      element.scrollLeft = position.left;
    }
  }, [active, order]);
  return <div className={className} hidden={!active} onScrollCapture={event => {
    if (!active) return;
    const element = event.target as HTMLElement;
    if (element.clientHeight || element.clientWidth) positions.current.set(element, { top: element.scrollTop, left: element.scrollLeft });
  }}><RecoverableBoundary region="workspace-pane">{children}</RecoverableBoundary></div>;
}
