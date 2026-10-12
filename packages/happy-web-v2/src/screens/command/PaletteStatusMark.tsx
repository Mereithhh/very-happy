import { CircleAlert, CircleHelp, Unplug } from 'lucide-react';
import { agentStatusSignal, codingAgentLabel, type AgentExecution } from '@/sync/agentStatus';
import { agentStatusLabelTokens, formatAgentStatusLabel } from '@/utils/agentStatusLabel';
import { Spinner } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * B-552: the sidebar row's status mark for a palette row — same signal
 * (agentStatusSignal), same glyphs, same label (agentStatusLabelTokens mirrors
 * the sidebar's assembly incl. the agent prefix and offline/unknown notes) and
 * the same color tokens as `.sb-row-status*` in sidebar.css. Idle-and-read
 * renders nothing, exactly like the sidebar. Sidebar.tsx (another task's
 * hotspot) still renders its own inline copy; it can adopt this later.
 */
export function PaletteStatusMark({
  execution,
  unread,
  flavor,
  backgroundTasks,
  legacy,
}: {
  execution: AgentExecution;
  unread: boolean;
  flavor?: string | null;
  backgroundTasks?: number;
  legacy?: boolean;
}) {
  const { t } = useTranslation();
  const status = agentStatusSignal(execution, unread);
  if (!status) return null;
  const label = formatAgentStatusLabel(
    agentStatusLabelTokens({ signal: status, execution, agentLabel: codingAgentLabel(flavor), backgroundTasks, legacy }),
    (tok) => (tok.key === 'sidebar.rowBackgroundTasks' ? t(tok.key, { count: tok.count }) : t(tok.key)),
  );
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
