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

export function peekCopy(zh: boolean) {
  return zh
    ? { idle: '空闲', preview: '预览', branch: '分支', model: '模型', status: '状态', you: '你', unread: '未读', pending: (n: number) => `待处理 ${n}`, noRound: '这个标签页还没加载过对话', label: '会话预览' }
    : { idle: 'Idle', preview: 'Preview', branch: 'Branch', model: 'Model', status: 'Status', you: 'You', unread: 'Unread', pending: (n: number) => `${n} pending`, noRound: 'Conversation not loaded in this tab yet', label: 'Session preview' };
}

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
  const { lang } = useTranslation();
  const copy = peekCopy(lang.startsWith('zh'));
  return (
    <Popover.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Popover.Anchor virtualRef={anchorRef as React.RefObject<HTMLElement>} />
      <Popover.Portal>
        {open && (
          <PeekBody session={session} title={title} agentLabel={agentLabel} statusLabel={statusLabel} unread={unread} copy={copy} />
        )}
      </Popover.Portal>
    </Popover.Root>
  );
}

function PeekBody({ session, title, agentLabel, statusLabel, unread, copy }: {
  session: Session;
  title: string;
  agentLabel: string;
  statusLabel: string;
  unread: boolean;
  copy: ReturnType<typeof peekCopy>;
}) {
  const facts = peekFacts(session);
  const round = useSessionPreview(session.id);
  const [branch, setBranch] = useState<string | undefined>(() => cachedBranch(session.id));
  const coarse = (() => { try { return window.matchMedia?.('(pointer: coarse)').matches === true; } catch { return false; } })();
  useEffect(() => {
    let live = true;
    void lookupBranch(session.id, { active: session.active, path: session.metadata?.path },
      (cwd) => sessionBash(session.id, { command: 'git rev-parse --abbrev-ref HEAD', cwd, timeout: 3000 }))
      .then((b) => { if (live) setBranch(b); });
    return () => { live = false; };
  }, [session.id, session.active, session.metadata?.path]);

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
      aria-label={copy.label}
      onOpenAutoFocus={(e) => e.preventDefault()}
      onCloseAutoFocus={(e) => e.preventDefault()}
      // The row menu hands focus back to its "…" button right as we open.
      onFocusOutside={(e) => e.preventDefault()}
    >
      <div className="sb-peek-title">{title}</div>
      {where && <div className="sb-peek-where mono" title={session.metadata?.path}>{where}</div>}
      <dl className="sb-peek-facts">
        {branch && (<><dt>{copy.branch}</dt><dd className="mono">{branch}</dd></>)}
        {runtime && (<><dt>{copy.model}</dt><dd>{runtime}</dd></>)}
        <dt>{copy.status}</dt>
        <dd>
          {statusLabel}
          {(unread || facts.pending > 0) && (
            <span className="sb-peek-counts">
              {unread && <span className="sb-peek-unread"><span className="sb-row-unread-dot" aria-hidden />{copy.unread}</span>}
              {facts.pending > 0 && <span className="sb-peek-pending">{copy.pending(facts.pending)}</span>}
            </span>
          )}
        </dd>
      </dl>
      {round?.user || round?.agent ? (
        <div className="sb-peek-round">
          {round.user && <p className="sb-peek-user"><span className="sb-peek-who">{copy.you}</span>{round.user}</p>}
          {round.agent && <p className="sb-peek-agent"><span className="sb-peek-who">{agentLabel}</span>{round.agent}</p>}
        </div>
      ) : (
        <p className="sb-peek-empty">{copy.noRound}</p>
      )}
    </Popover.Content>
  );
}
