/**
 * B-498: small pieces shared by the board band, the list and the detail —
 * status badge, machine tag, session link, attention reason, error toast.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AutomationRun, AutomationRunSource } from '@slopus/happy-wire';
import { Badge, StatusDot, toast } from '@/ui';
import { useTranslation, type TranslationKey } from '@/i18n/useTranslation';
import { useMachine, useSession } from '@/sync/storage';
import { isMachineOnline, machineLabel } from '@/utils/machineUtils';
import { getSessionName } from '@/utils/sessionUtils';
import { AutomationsApiError } from '@/sync/apiAutomations';
import { attentionKind, runTone, type AttentionKind, type RunTone } from './automationPresentation';

const STATUS_KEY: Record<string, TranslationKey> = {
  queued: 'automations.statusQueued',
  claimed: 'automations.statusClaimed',
  running: 'automations.statusRunning',
  done: 'automations.statusDone',
  failed: 'automations.statusFailed',
  skipped: 'automations.statusSkipped',
  expired: 'automations.statusExpired',
  cancelled: 'automations.statusCancelled',
};
const SOURCE_KEY: Record<AutomationRunSource, TranslationKey> = {
  schedule: 'automations.sourceSchedule',
  fire: 'automations.sourceFire',
  manual: 'automations.sourceManual',
};
const REASON_KEY: Record<Exclude<AttentionKind, 'other'>, TranslationKey> = {
  needs_input: 'automations.reasonNeedsInput',
  failed: 'automations.reasonFailed',
  expired: 'automations.reasonExpired',
  machine_offline: 'automations.reasonMachineOffline',
  unknown_outcome: 'automations.reasonUnknownOutcome',
  daemon_restarted: 'automations.reasonDaemonRestarted',
  invalid_action: 'automations.reasonInvalidAction',
};
const TONE_BADGE: Record<RunTone, { tone: 'live' | 'warn' | 'err' | 'muted'; dot: boolean }> = {
  wait: { tone: 'muted', dot: true },
  live: { tone: 'live', dot: true },
  ok: { tone: 'muted', dot: false },
  err: { tone: 'err', dot: true },
  muted: { tone: 'muted', dot: false },
};

export function useRunStatusLabel(): (status: string) => string {
  const { t } = useTranslation();
  return (status) => {
    const key = STATUS_KEY[status];
    return key ? (t(key) as string) : status; // newer server enum → verbatim
  };
}

export function RunStatusBadge({ status }: { status: string }) {
  const label = useRunStatusLabel();
  const { tone, dot } = TONE_BADGE[runTone(status)];
  return (
    <Badge tone={tone} dot={dot}>
      {label(status)}
    </Badge>
  );
}

export function useSourceLabel(): (source: AutomationRunSource | string) => string {
  const { t } = useTranslation();
  return (source) => {
    const key = SOURCE_KEY[source as AutomationRunSource];
    return key ? (t(key) as string) : String(source);
  };
}

/** the attention sentence for a run — vocabulary reasons get wording, others show verbatim */
export function useAttentionReason(): (run: Pick<AutomationRun, 'status' | 'attentionReason'>) => string {
  const { t } = useTranslation();
  return (run) => {
    const kind = attentionKind(run);
    if (kind === 'other') return run.attentionReason || (t('automations.reasonFailed') as string);
    return t(REASON_KEY[kind]) as string;
  };
}

export function MachineTag({ machineId }: { machineId: string }) {
  const { t } = useTranslation();
  const machine = useMachine(machineId);
  if (!machine) {
    return (
      <span className="au-machine mono" title={machineId}>
        <StatusDot status="offline" size={7} title={t('automations.unknownMachine') as string} />
        {t('automations.unknownMachine')}
      </span>
    );
  }
  const online = isMachineOnline(machine);
  return (
    <Link className="au-machine mono" to={`/machine/${encodeURIComponent(machine.id)}`} title={online ? (t('automations.online') as string) : (t('automations.offline') as string)}>
      <StatusDot status={online ? 'connected' : 'offline'} size={7} title={online ? (t('automations.online') as string) : (t('automations.offline') as string)} />
      {machineLabel(machine)}
    </Link>
  );
}

/** a run's session: name when the store knows it, short id otherwise */
export function SessionLink({ sessionId, className }: { sessionId: string; className?: string }) {
  const session = useSession(sessionId);
  const label = session ? getSessionName(session) : sessionId.slice(0, 8);
  return (
    <Link className={className ?? 'au-session-link'} to={`/session/${encodeURIComponent(sessionId)}`} title={sessionId}>
      {label}
    </Link>
  );
}

/** ticking `now` for relative labels (30s, like the board) */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function reportAutomationError(error: unknown, t: ReturnType<typeof useTranslation>['t']): void {
  const code = error instanceof AutomationsApiError ? error.code : error instanceof Error ? error.message : 'unknown';
  toast.error(t('automations.actionFailed', { code }) as string);
}
