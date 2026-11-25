/**
 * B-976 — 「有 N 条更新说明 · 查看 · ✕」 when the notes were held back (B-697
 * deep link, B-823 the person already typing). It replaces B-842's 10-second
 * toast, which ran out unseen on a page loaded in the background and left a
 * phone's session screen — no sidebar entry there — with no sign of the notes.
 *
 * A row in the layout, never a layer: it renders into the first slot on screen
 * (changelogHintSlots.ts) — in the sidebar in place of its 「更新说明」 row, or
 * under the session title bar, pushing the conversation down — so it covers
 * neither the title bar's buttons nor the composer, and it never takes focus.
 * It steps aside while the notes are open, while a dialog above `notice` holds
 * the turn, and while a newer shell waits for a refresh: the update prompt
 * alone says so then, and the bar comes after the refresh (B-914).
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { getPendingUpdate, subscribePendingUpdate } from './pendingUpdate';
import { dismissChangelogHint, useChangelogHint } from './changelogReadStore';
import { currentChangelogHintSlot, setChangelogHintShownIn, useChangelogHintSlotsVersion } from './changelogHintSlots';

function usePendingUpdate(): boolean {
  const [pending, setPending] = useState(() => getPendingUpdate() !== null);
  useEffect(() => subscribePendingUpdate((next) => setPending(next !== null)), []);
  return pending;
}

/** Re-picks the slot when one comes or goes and when the layout changes size (sidebar folds, phone ↔ desktop). */
function useHintSlot(active: boolean) {
  const version = useChangelogHintSlotsVersion();
  const [resized, setResized] = useState(0);
  useEffect(() => {
    if (!active) return;
    const onResize = () => setResized((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [active]);
  void version; void resized;
  return active ? currentChangelogHintSlot() : null;
}

export function ChangelogHintBar({ count, suppressed, onOpen }: { count: number; suppressed: boolean; onOpen: () => void }) {
  const { t } = useTranslation();
  const hint = useChangelogHint();
  const updateWaiting = usePendingUpdate();
  const visible = hint.wanted && !hint.dismissed && count > 0 && !suppressed && !updateWaiting;
  const target = useHintSlot(visible);
  const shownIn = target?.kind ?? null;
  useEffect(() => {
    setChangelogHintShownIn(shownIn);
    return () => setChangelogHintShownIn(null);
  }, [shownIn]);

  if (!target) return null;
  return createPortal(
    <div className="wn-hint" role="status" data-testid="changelog-hint" data-slot={target.kind}>
      <Sparkles size={14} aria-hidden="true" />
      <span className="wn-hint-text">{t('changelog.hint', { count })}</span>
      <button type="button" className="wn-hint-open" onClick={onOpen}>{t('changelog.hintOpen')}</button>
      <button type="button" className="wn-hint-close" aria-label={t('common.close')} onClick={dismissChangelogHint}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>,
    target.slot,
  );
}
