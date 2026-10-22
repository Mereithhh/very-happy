/**
 * B-759: a sidebar team row. The row (click, Enter) opens the team page, the
 * chevron only folds the member list, and the expanded 「负责人」 row opens the
 * lead. The context menu holds team page / lead / settings / fold — no hover
 * button. Shared by every grouping view (project / tag / none) — Sidebar
 * renders team headers in one place. B-721 added the lead status on the row.
 */
import type { KeyboardEvent, ReactNode } from 'react';
import type { TeamState } from '@slopus/happy-wire';
import { ChevronRight, ChevronDown, CircleAlert, LayoutDashboard, MessageSquare, Settings2, UsersRound } from 'lucide-react';
import { ActionContextMenu, Spinner, type MenuItemDef } from '@/ui';
import type { AgentExecution } from '@/sync/agentStatus';
import { teamRowTarget } from './teamNavigation';

export interface SidebarTeamRowCopy {
  expand: string;
  collapse: string;
  openBoard: string;
  openTeam: string;
  openLead: string;
  settings: string;
  leadStatus: string;
}

export function SidebarTeamRow(props: {
  team: TeamState;
  open: boolean;
  /** current pathname */
  pathname: string;
  subtitle: string;
  /** the lead session's status slot, same verdicts as a session row (null = nothing to show) */
  leadStatus: AgentExecution | 'unread' | null;
  leadStatusLabel?: string;
  copy: SidebarTeamRowCopy;
  badge?: ReactNode;
  onToggle: () => void;
  onNavigate: (href: string) => void;
}) {
  const { team, open, copy } = props;
  const target = teamRowTarget(team);
  // The team page is "this row"; the lead's page is this row only while the
  // lead's own member row is folded away.
  const selected = props.pathname === target.href || (!open && target.leadHref !== null && props.pathname === target.leadHref);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === 'ArrowRight' && !open) || (e.key === 'ArrowLeft' && open)) {
      e.preventDefault();
      props.onToggle();
    }
  };
  const status = props.leadStatus;
  const items: MenuItemDef[] = [
    { key: 'open-board', label: copy.openBoard, icon: LayoutDashboard, onSelect: () => props.onNavigate(target.href) },
    ...(target.leadHref ? [{ key: 'open-lead', label: copy.openLead, icon: MessageSquare, onSelect: () => props.onNavigate(target.leadHref!) } satisfies MenuItemDef] : []),
    { key: 'settings', label: copy.settings, icon: Settings2, onSelect: () => props.onNavigate(target.settingsHref) },
    { key: 'toggle', label: open ? copy.collapse : copy.expand, icon: open ? ChevronDown : ChevronRight, onSelect: props.onToggle },
  ];
  return (
    <ActionContextMenu items={items}>
      <div className={`sb-team-row${selected ? ' is-selected' : ''}`} data-team-id={team.id}>
        <button type="button" className="sb-team-toggle" aria-expanded={open} aria-label={`${open ? copy.collapse : copy.expand}: ${team.name}`} onClick={props.onToggle}>
          <ChevronRight size={15} className={open ? 'is-open' : ''} />
        </button>
        <button type="button" className="sb-team-main" data-href={target.href} aria-current={selected ? 'page' : undefined} title={`${copy.openTeam} · ${team.name}`} onClick={() => props.onNavigate(target.href)} onKeyDown={onKeyDown}>
          <UsersRound size={17} /><span><strong>{team.name}</strong><small>{props.subtitle}</small></span>
          {status && status !== 'idle' && (
            <span className={`sb-row-status sb-row-status--${status} sb-team-lead-status`} role="img" aria-label={props.leadStatusLabel ? `${copy.leadStatus} · ${props.leadStatusLabel}` : copy.leadStatus} title={props.leadStatusLabel ? `${copy.leadStatus} · ${props.leadStatusLabel}` : undefined}>
              {status === 'running' || status === 'background' ? <Spinner size={14} /> : status === 'input' ? <CircleAlert size={14} /> : status === 'unread' ? <span className="sb-row-unread-dot" /> : null}
            </span>
          )}
          {props.badge}
        </button>
      </div>
    </ActionContextMenu>
  );
}
