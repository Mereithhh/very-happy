import type { ReactNode } from 'react';

type Tone = 'live' | 'warn' | 'err' | 'muted';

export function Badge({
  tone = 'muted',
  dot = true,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`vh-badge vh-badge--${tone}`}>
      {dot && <span className="vh-badge__dot" />}
      {children}
    </span>
  );
}

/** mono key/value chip, e.g. <Chip k="model">opus-4.8</Chip> */
export function Chip({ k, children }: { k?: string; children: ReactNode }) {
  return (
    <span className="vh-chip">
      {k && <span className="vh-chip__k">{k}</span>}
      {children}
    </span>
  );
}
