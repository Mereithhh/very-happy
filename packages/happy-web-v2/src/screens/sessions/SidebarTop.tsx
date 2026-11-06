/**
 * B-713/B-896: the sidebar's create rows and capability strip (desktop), the
 * chip row (phone) and the footer. Split out of Sidebar.tsx so they render in
 * component tests without the whole session list (spec
 * 2026-10-sidebar-header §B-896).
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { Activity, ChevronDown, CircleHelp, Contact, FolderKanban, FolderPlus, LayoutGrid, ListChecks, ListTodo, MessageSquareHeart, Plus, Settings, StickyNote, UsersRound, Zap } from 'lucide-react';
import { ActionDropdownMenu, QuickThemeToggle, Spinner, type MenuItemDef } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { prefetchSessionDetail } from '@/app/prefetchSessionDetail';
import { NotificationBell } from '@/screens/notifications/NotificationBell';
import { isEntryCurrent, moreMenuEntries, navAttentionTotal, navMenuLabel, stripFocusTarget, type SidebarActionRow, type SidebarChip, type SidebarNavEntry, type SidebarNavKey } from './sidebarNavEntries';

const navIcon = { issues: ListTodo, board: Activity, projects: FolderKanban, teams: UsersRound, automations: Zap, todos: ListChecks, people: Contact, feedback: MessageSquareHeart } as const;

/** Capability entries as menu items (phone 「更多 ▾」), each with its count. */
export function capabilityMenuItems(entries: readonly SidebarNavEntry[], names: Record<SidebarNavKey, string>, onNavigate: (path: string) => void): MenuItemDef[] {
  return entries.map((e) => ({ key: e.key, label: navMenuLabel(names[e.key], e.attention), icon: navIcon[e.key], onSelect: () => onNavigate(e.path) }));
}

function AttentionBadge({ count, tone }: { count: number; tone?: 'warn' }) {
  return count > 0 ? <span className={`sb-nav-attn mono${tone === 'warn' ? ' sb-nav-attn--warn' : ''}`} aria-hidden>{count}</span> : null;
}

/**
 * B-896: the capability entries as one row of equal icon cells under
 * 新建会话 ▾ — name (and count) in the native tooltip + aria-label, the count
 * as a corner badge. One Tab stop: ←/→/Home/End move inside, Enter opens;
 * the current page carries aria-current. 5 or 6 cells share the row width.
 */
export function CapabilityStrip(props: {
  entries: readonly SidebarNavEntry[];
  names: Record<SidebarNavKey, string>;
  activePath: string;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const entries = props.entries.filter((e) => !e.phoneOnly);
  const current = entries.findIndex((e) => isEntryCurrent(e.path, props.activePath));
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  if (entries.length === 0) return null;
  const tabStop = Math.min(focusIndex ?? Math.max(0, current), entries.length - 1);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const next = stripFocusTarget(e.key, tabStop, entries.length);
    if (next === null) return;
    e.preventDefault();
    setFocusIndex(next);
    e.currentTarget.querySelectorAll<HTMLElement>('.sb-cap-cell')[next]?.focus();
  };
  return (
    <div className="sb-cap-strip" role="toolbar" aria-label={t('sidebar.capabilities')} onKeyDown={onKeyDown}>
      {entries.map((e, i) => {
        const Icon = navIcon[e.key];
        const label = navMenuLabel(props.names[e.key], e.attention);
        return (
          <button key={e.key} type="button" className="sb-cap-cell" data-cap={e.key} tabIndex={i === tabStop ? 0 : -1} title={label} aria-label={label}
            aria-current={i === current ? 'page' : undefined}
            onFocus={() => setFocusIndex(i)} onClick={() => props.onNavigate(e.path)}>
            <Icon size={17} aria-hidden />
            <AttentionBadge count={e.attention} tone={e.tone} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Desktop: 新建会话 | ▾ (▾ = every create type), 新建项目 / 新建团队 while the
 * account has none (B-896), then the capability strip.
 */
export function SidebarActionRows(props: {
  actions: readonly SidebarActionRow[];
  creatingChat: boolean;
  createItems: MenuItemDef[];
  capabilities: readonly SidebarNavEntry[];
  capabilityNames: Record<SidebarNavKey, string>;
  activePath: string;
  onNewChat: () => void;
  onNewProject: () => void;
  onNewTeam: () => void;
  onNavigate: (path: string) => void;
}) {
  const { t, lang } = useTranslation();
  const newRowRef = useRef<HTMLDivElement | null>(null);
  const [newRowWidth, setNewRowWidth] = useState<number>();
  if (props.actions.length === 0) return null;
  return (
    <div className="sb-actions">
      {props.actions.includes('new-session') && <div className="sb-new-split" ref={newRowRef}>
        <button type="button" className="sb-nav-btn sb-new-main" disabled={props.creatingChat} aria-busy={props.creatingChat} title={t('sidebar.newSession')} onPointerDown={prefetchSessionDetail} onClick={props.onNewChat}>
          {props.creatingChat ? <Spinner size={17} /> : <Plus size={17} />}<span>{props.creatingChat ? (lang.startsWith('zh') ? '正在创建…' : 'Creating…') : t('sidebar.newSession')}</span>
        </button>
        <ActionDropdownMenu align="end" sideOffset={4} contentMinWidth={newRowWidth} items={props.createItems}>
          <button type="button" className="sb-nav-btn sb-new-more" aria-label={t('sidebar.newMenu')} title={t('sidebar.newMenu')} onPointerDown={() => setNewRowWidth(newRowRef.current?.offsetWidth)}>
            <ChevronDown size={14} />
          </button>
        </ActionDropdownMenu>
      </div>}
      {props.actions.includes('new-project') && (
        <button type="button" className="sb-nav-btn" data-action="new-project" title={t('sidebar.newProject')} onClick={props.onNewProject}>
          <FolderPlus size={17} /><span>{t('sidebar.newProject')}</span>
        </button>
      )}
      {props.actions.includes('new-team') && (
        <button type="button" className="sb-nav-btn" data-action="new-team" title={t('sidebar.newTeam')} onClick={props.onNewTeam}>
          <UsersRound size={17} /><span>{t('sidebar.newTeam')}</span>
        </button>
      )}
      <CapabilityStrip entries={props.capabilities} names={props.capabilityNames} activePath={props.activePath} onNavigate={props.onNavigate} />
    </div>
  );
}

/**
 * Phone: one compact 44px chip row under the header — 项目 · 团队 · 更多 ▾.
 * B-756 (Lead 10-22): chips navigate — 项目 → /projects, 团队 → /teams, whose
 * pages carry 新建项目 / 新建团队; 更多 lists the remaining capabilities only.
 */
export function SidebarChipRow(props: {
  chips: readonly SidebarChip[];
  capabilities: readonly SidebarNavEntry[];
  capabilityNames: Record<SidebarNavKey, string>;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  if (props.chips.length === 0) return null;
  const more = moreMenuEntries(props.capabilities, props.chips);
  const attention = navAttentionTotal(more);
  // B-762 (D1): the 项目 chip carries the project tree's 需要你 total.
  const projectAttention = props.capabilities.find((e) => e.key === 'projects')?.attention ?? 0;
  const issueAttention = props.capabilities.find((e) => e.key === 'issues')?.attention ?? 0;
  return (
    <div className="sb-chips">
      {props.chips.includes('issues') && (
        <button type="button" className="sb-chip" data-cap="issues" aria-label={navMenuLabel(props.capabilityNames.issues, issueAttention)} title={props.capabilityNames.issues} onClick={() => props.onNavigate('/issues')}>
          <ListTodo size={16} /><span>{props.capabilityNames.issues}</span><AttentionBadge count={issueAttention} tone="warn" />
        </button>
      )}
      {props.chips.includes('projects') && (
        <button type="button" className="sb-chip" data-cap="projects" aria-label={navMenuLabel(props.capabilityNames.projects, projectAttention)} title={props.capabilityNames.projects} onClick={() => props.onNavigate('/projects')}>
          <FolderKanban size={16} /><span>{t('sidebar.chipProject')}</span><AttentionBadge count={projectAttention} tone="warn" />
        </button>
      )}
      {props.chips.includes('teams') && (
        <button type="button" className="sb-chip" data-cap="teams" aria-label={props.capabilityNames.teams} title={props.capabilityNames.teams} onClick={() => props.onNavigate('/teams')}>
          <UsersRound size={16} /><span>{t('sidebar.chipTeam')}</span>
        </button>
      )}
      {props.chips.includes('more') && more.length > 0 && (
        <ActionDropdownMenu align="start" sideOffset={4} items={capabilityMenuItems(more, props.capabilityNames, props.onNavigate)}>
          <button type="button" className="sb-chip sb-chip-more" aria-label={navMenuLabel(t('sidebar.moreCapabilities'), attention)} title={t('sidebar.moreCapabilities')}>
            <LayoutGrid size={16} /><span>{t('sidebar.moreEntries')}</span><AttentionBadge count={attention} /><ChevronDown size={14} />
          </button>
        </ActionDropdownMenu>
      )}
    </div>
  );
}

/** Footer: 设置 · 帮助 (B-713) · notes · theme · notifications — same row on desktop and the phone drawer. */
export function SidebarFooter(props: { onSettings: () => void; onHelp: () => void; onToggleNotes: () => void }) {
  const { t } = useTranslation();
  return (
    <footer className="sb-footer">
      <button type="button" className="sb-footer-btn sb-footer-settings" onClick={props.onSettings} aria-label={t('tabs.settings')} title={t('tabs.settings')}>
        <Settings size={16} /> <span>{t('tabs.settings')}</span>
      </button>
      <button type="button" className="sb-footer-btn sb-footer-help" onClick={props.onHelp} title={t('sidebar.openHelp')}>
        <CircleHelp size={16} /> <span>{t('sidebar.help')}</span>
      </button>
      {/* notes dock toggle (B-094) — app chrome, so it shares the footer row */}
      <button
        type="button"
        className="sb-footer-btn sb-footer-notes"
        onClick={props.onToggleNotes}
        aria-label={t('notes.title')}
        title={`${t('notes.title')} (⌘J)`}
      >
        <StickyNote size={16} />
      </button>
      <QuickThemeToggle className="sb-footer-btn sb-footer-icon sb-theme-toggle" />
      {/* Notification center: bell + unread badge + panel (self-contained;
          the collapsed desktop rail carries its own instance). It used to
          sit in the header, which was overflowing as header-right icons
          accumulated — down here it shares the settings row, the other
          "app chrome" affordance. */}
      <NotificationBell className="sb-footer-bell" />
    </footer>
  );
}
