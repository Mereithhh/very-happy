import { useCallback } from 'react';
import { ArrowUpRight, ArrowUpToLine, Archive, Check, MessageSquare, Pencil, TerminalSquare, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { StatusDot, ActionContextMenu, type MenuItemDef, type Status } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { upsertPinAt } from '@/screens/sessions/sidebarPins';
import { moveEntryToTop } from '@/screens/sessions/sidebarOrder';
import { confirmArchiveSession, confirmCloseTerminal, markSessionDone } from '@/app/rowActions';
import type { BoardItem } from './boardItems';

/** compact duration — mono console style, deliberately locale-neutral */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const DOT: Record<BoardItem['status'], { status: Status; pulse: boolean }> = {
  attention: { status: 'permission', pulse: true },
  working: { status: 'thinking', pulse: true },
  idle: { status: 'connected', pulse: false },
  ended: { status: 'offline', pulse: false },
};

export function BoardCard({
  item,
  now,
  onRenameRequest,
}: {
  item: BoardItem;
  now: number;
  /** opens the rename dialog for this card (hosted by the board screen) */
  onRenameRequest?: (item: BoardItem) => void;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const dot = DOT[item.status];
  const title = item.title || t('session.newChat');
  const KindIcon = item.kind === 'terminal' ? TerminalSquare : MessageSquare;

  // Move to the top of the sidebar's manual order — board item keys are the
  // SAME keys the sidebar uses (session id / `t:<terminalId>`), so this just
  // works. Pre-materialization (empty sidebarOrder) it writes the legacy
  // pinnedRows top slot instead, which the first drag's materialization folds
  // in — see sidebarOrder.ts.
  const onMoveToTop = useCallback(() => {
    const st = storage.getState().settings;
    const cur = st.sidebarOrder ?? [];
    if (cur.length > 0) {
      const next = moveEntryToTop(cur, item.key);
      if (next !== cur) sync.applySettings({ sidebarOrder: next });
    } else {
      const next = upsertPinAt(st.pinnedRows ?? [], item.key, 0);
      if (next !== (st.pinnedRows ?? [])) sync.applySettings({ pinnedRows: next });
    }
  }, [item.key]);

  // Mark done — the one-click completion (Owner boundary: no confirm dialog
  // for sessions; the terminal variant is a tmux kill and keeps its confirm).
  const onMarkDone = useCallback(() => {
    if (item.kind === 'session') {
      const session = storage.getState().sessions[item.key];
      if (session) void markSessionDone(session);
    } else if (item.machineId) {
      void confirmCloseTerminal(item.machineId, item.key.slice(2));
    }
  }, [item.kind, item.key, item.machineId]);

  // Card actions as data — right-click (fine pointers) / long-press (touch).
  // Archive/delete flows are the sidebar's, via rowActions.
  const menuItems: MenuItemDef[] = [
    {
      key: 'done',
      label: t('board.markDone'),
      icon: Check,
      onSelect: onMarkDone,
    },
    {
      key: 'open',
      label: t('common.open'),
      icon: ArrowUpRight,
      onSelect: () => navigate(item.href),
    },
    {
      key: 'move-top',
      label: t('sidebar.moveToTop'),
      icon: ArrowUpToLine,
      onSelect: onMoveToTop,
    },
  ];
  if (onRenameRequest) {
    menuItems.push({
      key: 'rename',
      label: t('common.rename'),
      icon: Pencil,
      onSelect: () => onRenameRequest(item),
    });
  }
  if (item.kind === 'session') {
    menuItems.push({
      key: 'archive',
      label: t('common.archive'),
      icon: Archive,
      danger: true,
      separatorBefore: true,
      onSelect: () => {
        const session = storage.getState().sessions[item.key];
        if (session) void confirmArchiveSession(session);
      },
    });
  } else if (item.machineId) {
    const machineId = item.machineId;
    const terminalId = item.key.slice(2); // `t:<terminalId>`
    // Archive-only (B-083): closing is neutral — tmux ends, the claude
    // conversation inside survives on the machine (`claude --resume`).
    menuItems.push({
      key: 'close',
      label: t('common.close'),
      icon: X,
      separatorBefore: true,
      onSelect: () => void confirmCloseTerminal(machineId, terminalId),
    });
  }

  // Root is a div-with-button-semantics, NOT a <button>: the ✓ inside would
  // otherwise be a nested interactive element (invalid HTML, broken focus).
  return (
    <ActionContextMenu items={menuItems}>
      <div
        role="button"
        tabIndex={0}
        className={`bd-card bd-card--${item.status}`}
        onClick={() => navigate(item.href)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return; // let the ✓ handle its own keys
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            navigate(item.href);
          }
        }}
      >
        <div className="bd-card-head">
          <StatusDot status={dot.status} pulse={dot.pulse} size={8} />
          <span className="bd-card-title">{title}</span>
          <button
            type="button"
            className="bd-card-done"
            title={t('board.markDone')}
            aria-label={t('board.markDone')}
            onClick={(e) => {
              e.stopPropagation();
              onMarkDone();
            }}
          >
            <Check size={13} />
          </button>
          <KindIcon size={14} className="bd-card-kind" aria-hidden />
        </div>
        <div className="bd-card-meta mono">
          <span className="bd-card-machine">{item.machineName}</span>
          {item.cwd && <span className="bd-card-cwd">{item.cwd}</span>}
        </div>
        {item.progress && <div className="bd-card-progress">{item.progress}</div>}
        <div className="bd-card-foot mono">
          {item.llmAttention && (
            <span className={`bd-card-llm bd-card-llm--${item.llmAttention}`}>
              {item.llmAttention === 'blocked' ? t('board.llmBlocked') : t('board.llmReview')}
            </span>
          )}
          {item.detail?.kind === 'tool' && <span className="bd-card-tool">{item.detail.name}</span>}
          {item.detail?.kind === 'machineOffline' && (
            <span className="bd-card-offline">{t('board.machineOffline')}</span>
          )}
          {item.status === 'ended' && item.detail?.kind !== 'machineOffline' && (
            <span className="bd-card-offline">{t('board.endedTag')}</span>
          )}
          {item.waitReason === 'idle' && (
            <span className="bd-card-offline">{t('board.readyToReview')}</span>
          )}
          <span className="bd-card-time">
            {item.status === 'attention' && item.attentionSince != null
              ? t('board.waitingFor', { duration: fmtDuration(now - item.attentionSince) })
              : `${fmtDuration(now - item.lastActivityAt)} ${t('board.agoSuffix')}`}
          </span>
        </div>
      </div>
    </ActionContextMenu>
  );
}
