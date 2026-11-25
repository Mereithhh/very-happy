/** B-976: an empty in-flow place for the 「有 N 条更新说明」 bar (see changelogHintSlots.ts). */
import { useCallback, useRef } from 'react';
import { registerChangelogHintSlot, type ChangelogHintSlotKind } from './changelogHintSlots';

export function ChangelogHintSlot({ kind }: { kind: ChangelogHintSlotKind }) {
  const off = useRef<(() => void) | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    off.current?.();
    off.current = el ? registerChangelogHintSlot(kind, el) : null;
  }, [kind]);
  return <div ref={ref} className="wn-hint-slot" data-kind={kind} />;
}
