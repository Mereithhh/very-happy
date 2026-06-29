import type { ReactNode } from 'react';
import { CyberMark } from './CyberMark';

/**
 * Single unified empty state (audit S4: collapses the old three divergent empty
 * screens into one component driven by props).
 */
export function EmptyState({
  title,
  description,
  icon,
  actions,
  compact = false,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`vh-empty${compact ? ' vh-empty--compact' : ''}`}>
      <div className="vh-empty__icon">{icon ?? <CyberMark size={compact ? 32 : 44} glow />}</div>
      <div className="vh-empty__title">{title}</div>
      {description && <div className="vh-empty__desc">{description}</div>}
      {actions && <div className="vh-empty__actions">{actions}</div>}
    </div>
  );
}
