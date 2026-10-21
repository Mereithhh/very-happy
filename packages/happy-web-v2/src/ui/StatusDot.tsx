/**
 * Unified status indicator — the audit's S3 fix: collapse the old 5-branch dot
 * logic into 4 canonical states with consistent color + aria, staggered pulse.
 */
export type Status = 'connected' | 'thinking' | 'permission' | 'offline';

import { t } from '@/text';

/** B-728 (UI-P1-10): localized default tooltip / aria label. */
const LABEL_KEYS = {
  connected: 'status.dotConnected',
  thinking: 'status.dotWorking',
  permission: 'status.dotPermission',
  offline: 'status.dotOffline',
} as const satisfies Record<Status, string>;

interface StatusDotProps {
  status: Status;
  pulse?: boolean;
  /** phase offset (ms) so a list of dots doesn't pulse in unison */
  phase?: number;
  size?: number;
  title?: string;
}

export function StatusDot({ status, pulse, phase = 0, size = 8, title }: StatusDotProps) {
  return (
    <span
      className={`vh-dot vh-dot--${status}${pulse ? ' vh-dot--pulse' : ''}`}
      style={{ width: size, height: size, animationDelay: phase ? `${phase}ms` : undefined }}
      role="img"
      aria-label={title ?? t(LABEL_KEYS[status])}
      title={title ?? t(LABEL_KEYS[status])}
    />
  );
}
