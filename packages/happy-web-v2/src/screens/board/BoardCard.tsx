import { useCallback } from 'react';
import { ArrowUpRight, Archive, MessageSquare, Pencil, Pin, PinOff, TerminalSquare, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { StatusDot, ActionContextMenu, type MenuItemDef, type Status } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { useSetting, storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { isPinned, togglePin } from '@/screens/sessions/sidebarPins';
import { confirmArchiveSession, confirmDeleteTerminal } from '@/app/rowActions';
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

  // Sidebar pin — board item keys are the SAME keys the pinned section uses
  // (session id / `t:<terminalId>`), so pinning from the board just works.
  const pinnedSetting = useSetting('pinnedRows');
  const pinned = isPinned(pinnedSetting ?? [], item.key);
  const onTogglePin = useCallback(() => {
    sync.applySettings({ pinnedRows: togglePin(pinnedSetting ?? [], item.key) });
  }, [pinnedSetting, item.key]);

  // Card actions as data — right-click (fine pointers) / long-press (touch).
  // Archive/delete flows are the sidebar's, via rowActions.
  const menuItems: MenuItemDef[] = [
    {
      key: 'open',
      label: t('common.open'),
      icon: ArrowUpRight,
      onSelect: () => navigate(item.href),
    },
    {
      key: 'pin',
      label: pinned ? t('sidebar.unpin') : t('sidebar.pin'),
      icon: pinned ? PinOff : Pin,
      onSelect: onTogglePin,
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
    menuItems.push({
      key: 'delete',
      label: t('common.delete'),
      icon: Trash2,
      danger: true,
      separatorBefore: true,
      onSelect: () => void confirmDeleteTerminal(machineId, terminalId),
    });
  }

  return (
    <ActionContextMenu items={menuItems}>
      <button
        type="button"
        className={`bd-card bd-card--${item.status}`}
        onClick={() => navigate(item.href)}
      >
        <div className="bd-card-head">
          <StatusDot status={dot.status} pulse={dot.pulse} size={8} />
          <span className="bd-card-title">{title}</span>
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
          <span className="bd-card-time">
            {item.status === 'attention' && item.attentionSince != null
              ? t('board.waitingFor', { duration: fmtDuration(now - item.attentionSince) })
              : `${fmtDuration(now - item.lastActivityAt)} ${t('board.agoSuffix')}`}
          </span>
        </div>
      </button>
    </ActionContextMenu>
  );
}
