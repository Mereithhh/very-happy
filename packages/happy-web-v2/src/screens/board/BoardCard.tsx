import { useCallback } from 'react';
import { ArrowUpRight, ArrowUpToLine, Archive, Check, CircleHelp, MessageSquare, MoreHorizontal, Pencil, TerminalSquare, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { StatusDot, ActionContextMenu, ActionDropdownMenu, type MenuItemDef, type Status } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { upsertPinAt } from '@/screens/sessions/sidebarPins';
import { moveEntryToTop } from '@/screens/sessions/sidebarOrder';
import { confirmArchiveSession, confirmCloseTerminal, markSessionDoneWithUndo } from '@/app/rowActions';
import { fmtDuration, type BoardItem } from './boardItems';
import { useSessionPreview } from './useBoardItems';
import { codingAgentLabel } from '@/sync/agentStatus';
import { boardProgressView, type KnownBoardPhase } from '@/sync/boardProgress';

export { fmtDuration };

const DOT: Record<BoardItem['status'], { status: Status; pulse: boolean }> = {
  attention: { status: 'permission', pulse: true },
  working: { status: 'thinking', pulse: true },
  idle: { status: 'connected', pulse: false },
  unknown: { status: 'offline', pulse: false },
  ended: { status: 'offline', pulse: false },
};

const PHASE_KEY: Record<KnownBoardPhase, 'board.phasePlanning' | 'board.phaseImplementing' | 'board.phaseTesting' | 'board.phaseReviewing' | 'board.phaseBlocked' | 'board.phaseDone'> = {
  planning: 'board.phasePlanning',
  implementing: 'board.phaseImplementing',
  testing: 'board.phaseTesting',
  reviewing: 'board.phaseReviewing',
  blocked: 'board.phaseBlocked',
  done: 'board.phaseDone',
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
  // B-556: board progress (report_progress / boardAnalyzer) with its phase,
  // de-emphasized when stale. `live` reuses the board's classification — no
  // second liveness judgement.
  const live = item.status === 'working' || item.status === 'attention';
  const progress = boardProgressView(
    item.progress ? { progress: item.progress, phase: item.progressPhase, analyzedAt: item.progressAt } : null,
    { now, live },
  );
  // B-558: only an idle card's badge describes how the round ended.
  const outcome = item.waitReason === 'idle' ? preview?.outcome : undefined;
  // B-558: an expired lease states the fact ("no update for 12m"), not a verdict.
  const noUpdate = item.status === 'unknown' && !item.legacyStatus;
  const noUpdateLabel = item.noUpdateSince !== undefined
    ? t('board.noUpdateFor', { duration: fmtDuration(now - item.noUpdateSince) })
    : t('board.noUpdate');

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
      if (session) markSessionDoneWithUndo(session); // B-566: undo window, then kill
    } else if (item.machineId) {
      void confirmCloseTerminal(item.machineId, item.key.slice(2));
    }
  }, [item.kind, item.key, item.machineId]);

  // Card actions as data — right-click (fine pointers) / long-press (touch)
  // and the card's ⋯ (B-798 U1: long-press is a shortcut, never the only way).
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
        data-flip-key={item.key}
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
          {/* B-798: same items as the long-press menu. The wrapper keeps clicks
              inside the (portalled) menu from bubbling to the card's navigate. */}
          <span className="bd-card-more-wrap" onClick={(e) => e.stopPropagation()}>
            <ActionDropdownMenu items={menuItems} align="end" sideOffset={4}>
              <button
                type="button"
                className="bd-card-more"
                title={t('common.moreActions')}
                aria-label={`${t('common.moreActions')}: ${title}`}
              >
                <MoreHorizontal size={14} />
              </button>
            </ActionDropdownMenu>
          </span>
        </div>
        <div className="bd-card-meta mono">
          <span className="bd-card-machine">{item.machineName}</span>
          {item.cwd && <span className="bd-card-cwd">{item.cwd}</span>}
        </div>
        {progress && (
          <div
            className={`bd-card-progress${progress.stale ? ' is-stale' : ''}`}
            title={progress.updatedAt !== undefined ? t(progress.stale ? 'board.progressStaleTitle' : 'board.progressTitle', { duration: fmtDuration(now - progress.updatedAt) }) : undefined}
          >
            {(progress.phase || progress.unknownPhase) && (
              <span className="bd-card-phase mono">
                {progress.phase ? t(PHASE_KEY[progress.phase]) : progress.unknownPhase}
              </span>
            )}
            {progress.text}
          </div>
        )}
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
          {/* B-553: the question block already names the tool */}
          {item.detail?.kind === 'tool' && !item.question && <span className="bd-card-tool">{item.detail.name}</span>}
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
                ? noUpdateLabel
                : `${fmtDuration(now - item.lastActivityAt)} ${t('board.agoSuffix')}`}
          </span>
        </div>
      </div>
    </ActionContextMenu>
  );
}
