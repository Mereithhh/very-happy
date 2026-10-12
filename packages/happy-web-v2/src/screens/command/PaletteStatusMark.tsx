import { CircleAlert, CircleHelp, Unplug } from 'lucide-react';
import { agentStatusSignal, type AgentExecution } from '@/sync/agentStatus';
import { Spinner } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * B-552: the sidebar row's status mark for a palette row — same signal
 * (agentStatusSignal), same glyphs, same tooltip copy keys and the same color
 * tokens as `.sb-row-status*` in sidebar.css. Idle-and-read renders nothing,
 * exactly like the sidebar. The sidebar still renders its own inline copy
 * (Sidebar.tsx is another task's hotspot); it can adopt this component later.
 */
export function PaletteStatusMark({
  execution,
  unread,
  backgroundTasks,
}: {
  execution: AgentExecution;
  unread: boolean;
  backgroundTasks?: number;
}) {
  const { t } = useTranslation();
  const status = agentStatusSignal(execution, unread);
  if (!status) return null;
  const label =
    status === 'running' ? t('sidebar.groupRunning')
    : status === 'background' ? t('sidebar.rowBackgroundTasks', { count: backgroundTasks ?? 1 })
    : status === 'input' ? t('sidebar.rowNeedsAttention')
    : status === 'unread' ? t('sidebar.rowUnread')
    : status === 'offline' ? t('sidebar.agentStatusOffline')
    : t('sidebar.agentStatusUnknown');
  return (
    <span className={`cp-status cp-status--${status}`} title={label} aria-label={label} role="img">
      {status === 'running' || status === 'background' ? <Spinner size={14} />
        : status === 'input' ? <CircleAlert size={14} />
        : status === 'unknown' ? <CircleHelp size={13} />
        : status === 'offline' ? <Unplug size={13} />
        : <span className="cp-status-dot" />}
    </span>
  );
}
