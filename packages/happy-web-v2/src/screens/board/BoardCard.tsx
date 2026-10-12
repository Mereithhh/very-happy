import { useCallback } from 'react';
import { ArrowUpRight, ArrowUpToLine, Archive, Check, CircleHelp, MessageSquare, Pencil, TerminalSquare, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { StatusDot, ActionContextMenu, type MenuItemDef, type Status } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { upsertPinAt } from '@/screens/sessions/sidebarPins';
import { moveEntryToTop } from '@/screens/sessions/sidebarOrder';
import { confirmArchiveSession, confirmCloseTerminal, markSessionDone } from '@/app/rowActions';
import { fmtDuration, type BoardItem } from './boardItems';
import { useSessionPreview } from './useBoardItems';
import { codingAgentLabel } from '@/sync/agentStatus';

export { fmtDuration };

const DOT: Record<BoardItem['status'], { status: Status; pulse: boolean }> = {
  attention: { status: 'permission', pulse: true },
  working: { status: 'thinking', pulse: true },
  idle: { status: 'connected', pulse: false },
  unknown: { status: 'offline', pulse: false },
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
  // B-553: latest round from messages this tab already holds (never fetches).
  const preview = useSessionPreview(item.kind === 'session' ? item.key : null);
  // B-558: only an idle card's badge describes how the round ended.
  const outcome = item.waitReason === 'idle' ? preview?.outcome : undefined;
  // B-558: an expired lease states the fact ("no update for 12m"), not a verdict.
  const noUpdate = item.status === 'unknown' && !item.legacyStatus;

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
        {item.question && (
          <div className="bd-card-question" title={t('board.questionLabel')}>
            <CircleHelp size={12} aria-label={t('board.questionLabel')} className="bd-card-question-icon" />
            <span className="bd-card-question-text">{item.question}</span>
          </div>
        )}
        {(preview?.user || preview?.agent) && (
          <div className="bd-card-preview">
            {preview.user && (
              <div className="bd-card-preview-user">
                <span className="bd-card-preview-who">{t('board.previewYou')}</span> {preview.user}
              </div>
            )}
            {preview.agent && (
              <div className="bd-card-preview-agent">
                <span className="bd-card-preview-who">{codingAgentLabel(item.agentKind)}</span> {preview.agent}
              </div>
            )}
          </div>
        )}
        <div className="bd-card-foot mono">
          {item.llmAttention && (
            <span className={`bd-card-llm bd-card-llm--${item.llmAttention}`}>
              {item.llmAttention === 'blocked' ? t('board.llmBlocked') : t('board.llmReview')}
            </span>
          )}
          {item.detail?.kind === 'tool' && <span className="bd-card-tool">{item.detail.name}</span>}
          {item.backgroundTasks !== undefined && item.backgroundTasks > 0 && (
            <span className="bd-card-background">{t('sidebar.rowBackgroundTasks', { count: item.backgroundTasks })}</span>
          )}
          {item.detail?.kind === 'machineOffline' && (
            <span className="bd-card-offline">{t('board.machineOffline')}</span>
          )}
          {item.status === 'ended' && item.detail?.kind !== 'machineOffline' && (
            <span className="bd-card-offline">{t('board.endedTag')}</span>
          )}
          {item.waitReason === 'unknown' && item.legacyStatus && <span className="bd-card-offline">{t('sidebar.agentStatusLegacy')}</span>}
          {item.waitReason === 'idle' && (
            outcome === 'interrupted' ? (
              <span className="bd-card-offline" title={t('board.interruptedByYouHint')}>{t('board.interruptedByYou')}</span>
            ) : outcome === 'failed' ? (
              <span className="bd-card-offline" title={t('board.lastRoundFailedHint')}>{t('board.lastRoundFailed')}</span>
            ) : (
              <span className="bd-card-offline">{t('board.readyToReview')}</span>
            )
          )}
          <span className="bd-card-time" title={noUpdate ? t('sidebar.agentStatusUnknown') : undefined}>
            {item.status === 'attention' && item.attentionSince != null
              ? t('board.waitingFor', { duration: fmtDuration(now - item.attentionSince) })
              : noUpdate
                ? t('board.noUpdateFor', { duration: fmtDuration(now - item.lastActivityAt) })
                : `${fmtDuration(now - item.lastActivityAt)} ${t('board.agoSuffix')}`}
          </span>
        </div>
      </div>
    </ActionContextMenu>
  );
}
