import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FolderKanban, UsersRound } from 'lucide-react';
import type { TrailKind, TrailSegment } from '@/app/locationTrail';
import './locationTrail.css';

const ICON: Record<TrailKind, typeof FolderKanban> = { projects: FolderKanban, project: FolderKanban, teams: UsersRound, team: UsersRound };

/**
 * B-763 breadcrumb: ancestor links, then the current page (`children`, which
 * keeps its own control — the session title stays the rename button). The
 * caller picks the segments (`visibleTrail`: phones get only the parent).
 */
export function LocationTrail({ segments, label, className, children }: { segments: TrailSegment[]; label: string; className?: string; children: ReactNode }) {
  return (
    <nav className={className ? `vh-trail ${className}` : 'vh-trail'} aria-label={label}>
      <ol>
        {segments.map((s) => {
          const Icon = ICON[s.kind];
          return (
            <li key={`${s.kind}:${s.href}`} className="vh-trail-item" data-kind={s.kind}>
              <Link className="vh-trail-link" to={s.href} title={s.label}><Icon size={14} aria-hidden /><span>{s.label}</span></Link>
              <span className="vh-trail-sep" aria-hidden>›</span>
            </li>
          );
        })}
        <li className="vh-trail-current" aria-current="page">{children}</li>
      </ol>
    </nav>
  );
}
