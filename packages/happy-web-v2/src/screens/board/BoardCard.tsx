import { MessageSquare, TerminalSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { StatusDot, type Status } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
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

export function BoardCard({ item, now }: { item: BoardItem; now: number }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const dot = DOT[item.status];
  const title = item.title || t('session.newChat');
  const KindIcon = item.kind === 'terminal' ? TerminalSquare : MessageSquare;

  return (
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
      <div className="bd-card-foot mono">
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
  );
}
