/**
 * B-713/B-896/B-926: the sidebar's create rows and capability rows (desktop), the
 * chip row (phone) and the footer. Split out of Sidebar.tsx so they render in
 * component tests without the whole session list (spec
 * 2026-10-sidebar-header §B-896).
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { Activity, ChevronDown, CircleHelp, Contact, Ellipsis, FolderKanban, FolderPlus, LayoutGrid, ListChecks, ListTodo, MessageSquareHeart, Pin, Plus, Settings, StickyNote, UsersRound, Zap } from 'lucide-react';
import { ActionDropdownMenu, Checkbox, QuickThemeToggle, Spinner, type MenuItemDef } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { prefetchSessionDetail } from '@/app/prefetchSessionDetail';
import { NotificationBell } from '@/screens/notifications/NotificationBell';
import { isEntryCurrent, moreMenuEntries, navAttentionTotal, navMenuLabel, splitNavEntries, stripFocusTarget, togglePinnedEntry, type SidebarActionRow, type SidebarChip, type SidebarNavEntry, type SidebarNavKey } from './sidebarNavEntries';

const navIcon = { issues: ListTodo, board: Activity, projects: FolderKanban, teams: UsersRound, automations: Zap, todos: ListChecks, people: Contact, feedback: MessageSquareHeart } as const;

/** Capability entries as menu items (phone 「更多 ▾」), each with its count. */
export function capabilityMenuItems(entries: readonly SidebarNavEntry[], names: Record<SidebarNavKey, string>, onNavigate: (path: string) => void): MenuItemDef[] {
  return entries.map((e) => ({ key: e.key, label: navMenuLabel(names[e.key], e.attention), icon: navIcon[e.key], onSelect: () => onNavigate(e.path) }));
}

function AttentionBadge({ count, tone }: { count: number; tone?: 'warn' }) {
  return count > 0 ? <span className={`sb-nav-attn mono${tone === 'warn' ? ' sb-nav-attn--warn' : ''}`} aria-hidden>{count}</span> : null;
}

/**
 * B-926 (Owner 11-11: 「都是一堆 logo，我都不知道是干啥的」): the capability
 * entries as labelled rows under 新建会话 ▾, like the Codex / Claude desktop
 * sidebars — icon + name, the count at the row end. The pinned rows (default:
 * the first four, `splitNavEntries`) stay; the rest sit in one 「更多 ▾」 row
 * whose badge sums what it hides, and whose last item 「调整入口」 lets the
 * user choose the rows (per device, `useSidebarPrefs.navPinned`).
 * Keyboard (unchanged from the B-896 strip): one Tab stop, ↑/↓ (and ←/→)
 * wrap, Home/End jump, Enter opens; the current page carries aria-current.
 */
export function CapabilityNav(props: {
  entries: readonly SidebarNavEntry[];
  names: Record<SidebarNavKey, string>;
  activePath: string;
  onNavigate: (path: string) => void;
  pinned: readonly string[] | null;
  onPinnedChange: (keys: string[] | null) => void;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const { pinned, more } = splitNavEntries(props.entries, props.pinned);
  // the 「更多」 row stays even when nothing is folded: it holds 「调整入口」
  const count = pinned.length + 1;
  const current = pinned.findIndex((e) => isEntryCurrent(e.path, props.activePath));
  const moreCurrent = more.some((e) => isEntryCurrent(e.path, props.activePath));
  const tabStop = Math.min(focusIndex ?? (current >= 0 ? current : moreCurrent ? count - 1 : 0), count - 1);
  const focusRow = (selector: string) => requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(selector)?.focus());
  if (props.entries.length === 0) return null;
  if (editing) {
    const done = () => { setEditing(false); focusRow('.sb-cap-more'); };
    return (
      <div className="sb-cap-edit" ref={rootRef} role="group" aria-label={t('sidebar.pinnedEntries')}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); done(); } }}>
        <div className="sb-cap-edit-head">
          <span>{t('sidebar.pinnedEntries')}</span>
          <button type="button" className="sb-cap-edit-btn" onClick={() => props.onPinnedChange(null)}>{t('sidebar.resetEntries')}</button>
          <button type="button" className="sb-cap-edit-btn sb-cap-edit-done" onClick={done}>{t('sidebar.editDone')}</button>
        </div>
        {props.entries.map((e) => {
          const Icon = navIcon[e.key];
          return (
            <Checkbox key={e.key} className="sb-cap-edit-row" data-cap={e.key} checked={pinned.includes(e)}
              onCheckedChange={() => props.onPinnedChange(togglePinnedEntry(props.entries, props.pinned, e.key))}>
              <Icon size={16} aria-hidden /><span>{props.names[e.key]}</span>
            </Checkbox>
          );
        })}
      </div>
    );
  }
  const moreAttention = navAttentionTotal(more);
  const moreLabel = navMenuLabel(t('sidebar.moreEntries'), moreAttention);
  const moreItems: MenuItemDef[] = [
    ...capabilityMenuItems(more, props.names, props.onNavigate),
    { key: 'edit-entries', label: t('sidebar.editEntries'), icon: Pin, separatorBefore: more.length > 0, onSelect: () => { setEditing(true); focusRow('.sb-cap-edit-done'); } },
  ];
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Radix's trigger takes ↓ / Enter on 「更多」 to open its menu
    if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const next = stripFocusTarget(e.key, tabStop, count);
    if (next === null) return;
    e.preventDefault();
    setFocusIndex(next);
    e.currentTarget.querySelectorAll<HTMLElement>('.sb-cap-row')[next]?.focus();
  };
  return (
    <div className="sb-cap-nav" ref={rootRef} role="toolbar" aria-orientation="vertical" aria-label={t('sidebar.capabilities')} onKeyDown={onKeyDown}>
      {pinned.map((e, i) => {
        const Icon = navIcon[e.key];
        const name = props.names[e.key];
        return (
          <button key={e.key} type="button" className="sb-cap-row" data-cap={e.key} tabIndex={i === tabStop ? 0 : -1} aria-label={navMenuLabel(name, e.attention)} title={name}
            aria-current={i === current ? 'page' : undefined}
            onFocus={() => setFocusIndex(i)} onClick={() => props.onNavigate(e.path)}>
            <Icon size={16} aria-hidden /><span className="sb-cap-name">{name}</span>
            <AttentionBadge count={e.attention} tone={e.tone} />
          </button>
        );
      })}
      <ActionDropdownMenu align="start" sideOffset={4} matchTriggerWidth items={moreItems}>
        <button type="button" className={`sb-cap-row sb-cap-more${moreCurrent ? ' is-current' : ''}`} tabIndex={tabStop === count - 1 ? 0 : -1}
          aria-label={moreLabel} title={t('sidebar.moreCapabilities')} onFocus={() => setFocusIndex(count - 1)}>
          <Ellipsis size={16} aria-hidden /><span className="sb-cap-name">{t('sidebar.moreEntries')}</span>
          <AttentionBadge count={moreAttention} />
          <ChevronDown size={14} className="sb-cap-chevron" aria-hidden />
        </button>
      </ActionDropdownMenu>
    </div>
  );
}

/**
 * Desktop: 新建会话 | ▾ (▾ = every create type), 新建项目 / 新建团队 while the
 * account has none (B-896), then the capability rows (B-926).
 */
export function SidebarActionRows(props: {
  actions: readonly SidebarActionRow[];
  creatingChat: boolean;
  createItems: MenuItemDef[];
  capabilities: readonly SidebarNavEntry[];
  capabilityNames: Record<SidebarNavKey, string>;
  activePath: string;
  pinnedEntries: readonly string[] | null;
  onPinnedEntriesChange: (keys: string[] | null) => void;
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
      <CapabilityNav entries={props.capabilities} names={props.capabilityNames} activePath={props.activePath} onNavigate={props.onNavigate}
        pinned={props.pinnedEntries} onPinnedChange={props.onPinnedEntriesChange} />
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
