/**
 * B-759: a sidebar team row. The row (click, Enter) opens the team page, the
 * chevron only folds the member list, and the expanded 「负责人」 row opens the
 * lead. The context menu holds team page / lead / settings / fold — no hover
 * button.
 *
 * B-762 (spec B-760 §5.1): a level-2 node of the project tree (level 1 under
 * 不在项目中) — one line, UsersRound 15, the 需要你 badge of its members (else
 * 「N 人」), a spinner while any member runs. Only the 按项目 lens draws teams;
 * ←/→ fold through the tree's one keyboard handler (Sidebar), and on touch the
 * long-press menu is a bottom sheet headed by the team name.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { TeamState } from '@slopus/happy-wire';
import { ChevronRight, ChevronDown, LayoutDashboard, MessageSquare, Settings2, UsersRound } from 'lucide-react';
import { ActionContextMenu, Spinner, type MenuItemDef } from '@/ui';
import { teamRowTarget } from './teamNavigation';

export interface SidebarTeamRowCopy {
  expand: string;
  collapse: string;
  openBoard: string;
  openTeam: string;
  openLead: string;
  settings: string;
  running: string;
}

export function SidebarTeamRow(props: {
  team: TeamState;
  open: boolean;
  /** current pathname */
  pathname: string;
  /** tree depth (1 under a project, 0 under 不在项目中) */
  depth: number;
  /** 需要你 count over the team's members (waiting + unread) */
  attention: number;
  attentionLabel?: string;
  /** shown when nothing needs the user: 「N 人」 / 「正在准备团队」 */
  countLabel: string;
  /** any member has a live turn */
  running: boolean;
  /** B-726: an old team outside every project, shown in 不在项目中 */
  unplacedLabel?: string;
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
  const items: MenuItemDef[] = [
    { key: 'open-board', label: copy.openBoard, icon: LayoutDashboard, onSelect: () => props.onNavigate(target.href) },
    ...(target.leadHref ? [{ key: 'open-lead', label: copy.openLead, icon: MessageSquare, onSelect: () => props.onNavigate(target.leadHref!) } satisfies MenuItemDef] : []),
    { key: 'settings', label: copy.settings, icon: Settings2, onSelect: () => props.onNavigate(target.settingsHref) },
    { key: 'toggle', label: open ? copy.collapse : copy.expand, icon: open ? ChevronDown : ChevronRight, separatorBefore: true, onSelect: props.onToggle },
  ];
  return (
    <ActionContextMenu items={items} sheetTitle={team.name}>
      <div className="sb-tree-node" data-tree-node data-depth={props.depth} style={{ '--depth': props.depth } as CSSProperties}>
        <div className={`sb-team-row${selected ? ' is-selected' : ''}`} data-team-id={team.id}>
          <button type="button" className="sb-tree-chevron sb-team-toggle" data-tree-toggle aria-expanded={open} aria-label={`${open ? copy.collapse : copy.expand}: ${team.name}`} tabIndex={-1} onClick={props.onToggle}>
            <ChevronRight size={13} className={open ? 'is-open' : ''} />
          </button>
          <button type="button" className="sb-team-main" data-tree-item data-href={target.href} aria-current={selected ? 'page' : undefined} title={`${copy.openTeam} · ${team.name}`} onClick={() => props.onNavigate(target.href)}>
            <UsersRound size={15} aria-hidden />
            <span className="sb-team-name">{team.name}</span>
            {props.unplacedLabel && <span className="sb-team-unplaced">{props.unplacedLabel}</span>}
            {props.running && <span className="sb-row-status sb-row-status--running" role="img" aria-label={copy.running} title={copy.running}><Spinner size={13} /></span>}
            {props.attention > 0
              ? <span className="sb-tree-badge" role="img" aria-label={props.attentionLabel} title={props.attentionLabel}>{props.attention}</span>
              : <span className="sb-tree-count">{props.countLabel}</span>}
            {props.badge}
          </button>
        </div>
      </div>
    </ActionContextMenu>
  );
}
