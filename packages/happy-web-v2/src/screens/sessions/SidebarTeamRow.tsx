/**
 * B-721: a sidebar team row. The name opens the lead's conversation (board as
 * the fallback), the chevron only folds the member list, and the board has its
 * own button plus a context-menu item. Shared by every grouping view (project /
 * tag / none) — Sidebar renders team headers in one place.
 */
import type { KeyboardEvent, ReactNode } from 'react';
import type { TeamState } from '@slopus/happy-wire';
import { ChevronRight, ChevronDown, CircleAlert, LayoutDashboard, MessageSquare, UsersRound } from 'lucide-react';
import { ActionContextMenu, Spinner, type MenuItemDef } from '@/ui';
import type { AgentExecution } from '@/sync/agentStatus';
import { teamRowTarget } from './teamNavigation';

export interface SidebarTeamRowCopy {
  expand: string;
  collapse: string;
  openBoard: string;
  openLead: string;
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
  // The board is "this row" on its page; the lead's page is this row only while
  // the lead's own member row is folded away.
  const selected = props.pathname === target.boardHref || (!open && target.leadSessionId !== null && props.pathname === target.href);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === 'ArrowRight' && !open) || (e.key === 'ArrowLeft' && open)) {
      e.preventDefault();
      props.onToggle();
    }
  };
  const status = props.leadStatus;
  const items: MenuItemDef[] = [
    ...(target.leadSessionId ? [{ key: 'open-lead', label: copy.openLead, icon: MessageSquare, onSelect: () => props.onNavigate(target.href) } satisfies MenuItemDef] : []),
    { key: 'open-board', label: copy.openBoard, icon: LayoutDashboard, onSelect: () => props.onNavigate(target.boardHref) },
    { key: 'toggle', label: open ? copy.collapse : copy.expand, icon: open ? ChevronDown : ChevronRight, onSelect: props.onToggle },
  ];
  return (
    <ActionContextMenu items={items}>
      <div className={`sb-team-row${selected ? ' is-selected' : ''}`} data-team-id={team.id}>
        <button type="button" className="sb-team-toggle" aria-expanded={open} aria-label={`${open ? copy.collapse : copy.expand}: ${team.name}`} onClick={props.onToggle}>
          <ChevronRight size={15} className={open ? 'is-open' : ''} />
        </button>
        <button type="button" className="sb-team-main" data-href={target.href} aria-current={selected ? 'page' : undefined} title={target.leadSessionId ? `${copy.openLead} · ${team.name}` : `${copy.openBoard} · ${team.name}`} onClick={() => props.onNavigate(target.href)} onKeyDown={onKeyDown}>
          <UsersRound size={17} /><span><strong>{team.name}</strong><small>{props.subtitle}</small></span>
          {status && status !== 'idle' && (
            <span className={`sb-row-status sb-row-status--${status} sb-team-lead-status`} role="img" aria-label={props.leadStatusLabel ? `${copy.leadStatus} · ${props.leadStatusLabel}` : copy.leadStatus} title={props.leadStatusLabel ? `${copy.leadStatus} · ${props.leadStatusLabel}` : undefined}>
              {status === 'running' || status === 'background' ? <Spinner size={14} /> : status === 'input' ? <CircleAlert size={14} /> : status === 'unread' ? <span className="sb-row-unread-dot" /> : null}
            </span>
          )}
          {props.badge}
        </button>
        <button type="button" className="sb-team-board" aria-label={`${copy.openBoard}: ${team.name}`} title={copy.openBoard} onClick={() => props.onNavigate(target.boardHref)}>
          <LayoutDashboard size={15} />
        </button>
      </div>
    </ActionContextMenu>
  );
}
