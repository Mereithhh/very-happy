/**
 * B-588 — read-only session preview anchored to a sidebar row.
 *
 * Opening (design-language §6): fine-pointer hover after PEEK_HOVER_DELAY_MS
 * (closes on leave), the row menu's 「预览」 (all devices — the only way on
 * touch), or Alt+Enter on the focused row. No actions inside; Esc / outside
 * click closes. Never steals focus.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useTranslation } from '@/i18n/useTranslation';
import type { Session } from '@/sync/storageTypes';
import { sessionBash } from '@/sync/ops';
import { useSessionPreview } from '@/screens/board/useBoardItems';
import { PEEK_HOVER_DELAY_MS, PEEK_HOVER_MEDIA, cachedBranch, lookupBranch, peekFacts } from './sessionPeekModel';
import './sessionPeek.css';

type OpenReason = 'hover' | 'explicit';

/** Hover/explicit open state for one row. */
export function useSessionPeek() {
  const [open, setOpen] = useState<OpenReason | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => clear, []);

  const canHover = () => {
    try { return window.matchMedia?.(PEEK_HOVER_MEDIA).matches === true; } catch { return false; }
  };

  const onPointerEnter = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.buttons !== 0 || !canHover()) return;
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      // A menu (row "…" / right-click) or a drag in progress wins.
      if (document.querySelector('.vh-menu, .sb-list.is-dragging')) return;
      setOpen((cur) => cur ?? 'hover');
    }, PEEK_HOVER_DELAY_MS);
  }, []);
  const onPointerLeave = useCallback(() => {
    clear();
    setOpen((cur) => (cur === 'hover' ? null : cur));
  }, []);
  const onPointerDown = useCallback(() => {
    clear();
    setOpen((cur) => (cur === 'hover' ? null : cur));
  }, []);
  /** Row menu / keyboard: open after the menu has closed and handed focus back. */
  const openExplicit = useCallback(() => {
    clear();
    requestAnimationFrame(() => setOpen('explicit'));
  }, []);
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      clear();
      setOpen((cur) => (cur ? null : 'explicit'));
    } else if (e.key === 'Escape') {
      setOpen(null);
    }
  }, []);
  const close = useCallback(() => { clear(); setOpen(null); }, []);
  return { open, close, openExplicit, rowHandlers: { onPointerEnter, onPointerLeave, onPointerDown }, onKeyDown };
}

export function SessionPeek({
  session,
  open,
  onClose,
  title,
  agentLabel,
  statusLabel,
  unread,
  anchorRef,
}: {
  session: Session;
  open: boolean;
  onClose: () => void;
  title: string;
  agentLabel: string;
  statusLabel: string;
  unread: boolean;
  /** the row element — a virtual anchor, so the row keeps its own trigger wrappers (context menu) */
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  return (
    <Popover.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Popover.Anchor virtualRef={anchorRef as React.RefObject<HTMLElement>} />
      <Popover.Portal>
        {open && (
          <PeekBody session={session} title={title} agentLabel={agentLabel} statusLabel={statusLabel} unread={unread} />
        )}
      </Popover.Portal>
    </Popover.Root>
  );
}

function PeekBody({ session, title, agentLabel, statusLabel, unread }: {
  session: Session;
  title: string;
  agentLabel: string;
  statusLabel: string;
  unread: boolean;
}) {
  const { t } = useTranslation();
  const facts = peekFacts(session);
  const round = useSessionPreview(session.id);
  // B-586 worktree sessions carry their branch in metadata — no RPC for those.
  const metaBranch = facts.branch;
  const [lookedUp, setLookedUp] = useState<string | undefined>(() => cachedBranch(session.id));
  const branch = metaBranch ?? lookedUp;
  const coarse = (() => { try { return window.matchMedia?.('(pointer: coarse)').matches === true; } catch { return false; } })();
  useEffect(() => {
    if (metaBranch) return;
    let live = true;
    void lookupBranch(session.id, { active: session.active, path: session.metadata?.path },
      (cwd) => sessionBash(session.id, { command: 'git rev-parse --abbrev-ref HEAD', cwd, timeout: 3000 }))
      .then((b) => { if (live) setLookedUp(b); });
    return () => { live = false; };
  }, [metaBranch, session.id, session.active, session.metadata?.path]);

  const where = [facts.machine, facts.path].filter(Boolean).join(' · ');
  const runtime = [agentLabel, facts.model].filter(Boolean).join(' · ');
  return (
    <Popover.Content
      className="sb-peek"
      side={coarse ? 'bottom' : 'right'}
      align="start"
      sideOffset={8}
      collisionPadding={12}
      hideWhenDetached
      aria-label={t('sessionPeek.label')}
      onOpenAutoFocus={(e) => e.preventDefault()}
      onCloseAutoFocus={(e) => e.preventDefault()}
      // The row menu hands focus back to its "…" button right as we open.
      onFocusOutside={(e) => e.preventDefault()}
    >
      <div className="sb-peek-title">{title}</div>
      {where && <div className="sb-peek-where mono" title={session.metadata?.path}>{where}</div>}
      <dl className="sb-peek-facts">
        {branch && (<><dt>{t('sessionPeek.branch')}</dt><dd className="mono">{branch}</dd></>)}
        {runtime && (<><dt>{t('sessionPeek.model')}</dt><dd>{runtime}</dd></>)}
        <dt>{t('sessionPeek.status')}</dt>
        <dd>
          {statusLabel}
          {(unread || facts.pending > 0) && (
            <span className="sb-peek-counts">
              {unread && <span className="sb-peek-unread"><span className="sb-row-unread-dot" aria-hidden />{t('sessionPeek.unread')}</span>}
              {facts.pending > 0 && <span className="sb-peek-pending">{t('sessionPeek.pending', { count: facts.pending })}</span>}
            </span>
          )}
        </dd>
      </dl>
      {round?.user || round?.agent ? (
        <div className="sb-peek-round">
          {round.user && <p className="sb-peek-user"><span className="sb-peek-who">{t('sessionPeek.you')}</span>{round.user}</p>}
          {round.agent && <p className="sb-peek-agent"><span className="sb-peek-who">{agentLabel}</span>{round.agent}</p>}
        </div>
      ) : (
        <p className="sb-peek-empty">{t('sessionPeek.notLoaded')}</p>
      )}
    </Popover.Content>
  );
}
