/**
 * B-713: the sidebar's create rows and capability rows (desktop), the chip
 * row (phone) and the footer. Split out of Sidebar.tsx so they render in
 * component tests without the whole session list (spec
 * 2026-10-sidebar-header §B-713).
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown, CircleHelp, Contact, FolderKanban, FolderPlus, LayoutGrid, ListChecks, MessageSquareHeart, Plus, Settings, StickyNote, UsersRound, Zap } from 'lucide-react';
import { ActionDropdownMenu, QuickThemeToggle, Spinner, type MenuItemDef } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { prefetchSessionDetail } from '@/app/prefetchSessionDetail';
import { NotificationBell } from '@/screens/notifications/NotificationBell';
import { MIN_LIST_ROWS, moreMenuEntries, navAttentionTotal, navMenuLabel, settleCapabilityRows, splitCapabilities, type SidebarActionRow, type SidebarChip, type SidebarNavEntry, type SidebarNavKey } from './sidebarNavEntries';

const navIcon = { projects: FolderKanban, teams: UsersRound, automations: Zap, todos: ListChecks, people: Contact, feedback: MessageSquareHeart } as const;

/** Capability entries as menu items (「更多能力 ▾」 / phone 「更多 ▾」), each with its count. */
export function capabilityMenuItems(entries: readonly SidebarNavEntry[], names: Record<SidebarNavKey, string>, onNavigate: (path: string) => void): MenuItemDef[] {
  return entries.map((e) => ({ key: e.key, label: navMenuLabel(names[e.key], e.attention), icon: navIcon[e.key], onSelect: () => onNavigate(e.path) }));
}

function AttentionBadge({ count, tone }: { count: number; tone?: 'warn' }) {
  return count > 0 ? <span className={`sb-nav-attn mono${tone === 'warn' ? ' sb-nav-attn--warn' : ''}`} aria-hidden>{count}</span> : null;
}

/**
 * Height the list needs so its first MIN_LIST_ROWS rows are fully on screen,
 * group heads and padding included (content coordinates). With fewer rows
 * than that, the average pitch so far is extrapolated.
 */
export function listHeightForRows(list: HTMLElement, fallbackPitch: number): number {
  const top = list.getBoundingClientRect().top - list.scrollTop;
  const rows = [...list.querySelectorAll<HTMLElement>('.sb-row, .sb-team-row')].filter((r) => r.offsetHeight > 0);
  if (rows.length === 0) return MIN_LIST_ROWS * fallbackPitch;
  const bottomOf = (r: HTMLElement) => r.getBoundingClientRect().bottom - top;
  if (rows.length >= MIN_LIST_ROWS) return bottomOf(rows[MIN_LIST_ROWS - 1]);
  const last = bottomOf(rows[rows.length - 1]);
  return last + (MIN_LIST_ROWS - rows.length) * (last / rows.length);
}

/**
 * B-713: how many capability rows fit while the list keeps MIN_LIST_ROWS rows
 * on screen. Re-measured whenever the sidebar resizes (window resize, notices)
 * or its content changes (list mounts late, groups fold), coalesced per frame.
 * B-828: `block` is the live 能力 block element (a callback ref), never an
 * element captured at mount. The sidebar stays mounted across desktop → phone
 * → desktop (B-795), which rebuilds the block; measuring the detached old one
 * (height 0) drops the block from the invariant below, so more rows measured
 * as less room and the rows flipped on every frame until a remount.
 */
function useCapabilityFit(listRef: RefObject<HTMLElement | null>, block: HTMLElement | null, total: number): number {
  const [shown, setShown] = useState(total);
  useLayoutEffect(() => {
    const root = block?.closest<HTMLElement>('.sb') ?? block?.parentElement;
    if (!block || !root) return;
    const measure = () => {
      const list = listRef.current;
      if (!list || !block.isConnected) return;
      const capRow = block.querySelector<HTMLElement>('.sb-nav-btn');
      const rowPitch = (capRow?.offsetHeight || 32) + 2;
      // list + block height is invariant while rows move between them
      const spare = list.clientHeight + block.offsetHeight - listHeightForRows(list, rowPitch);
      setShown((current) => settleCapabilityRows({ current, spare, rowPitch, total }));
    };
    measure();
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
    };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    ro?.observe(root);
    if (listRef.current) ro?.observe(listRef.current);
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
    mo?.observe(root, { childList: true, subtree: true });
    return () => { ro?.disconnect(); mo?.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [listRef, block, total]);
  return Math.min(shown, total);
}

/**
 * Desktop: 新建会话 | ▾, 新建项目, 新建团队, then 团队 / 自动化 / 待办 / 联系人
 * as rows while they fit, the rest under 「更多能力 ▾」.
 */
export function SidebarActionRows(props: {
  actions: readonly SidebarActionRow[];
  creatingChat: boolean;
  createItems: MenuItemDef[];
  capabilities: readonly SidebarNavEntry[];
  capabilityNames: Record<SidebarNavKey, string>;
  listRef: RefObject<HTMLElement | null>;
  onNewChat: () => void;
  onNewProject: () => void;
  onNewTeam: () => void;
  onNavigate: (path: string) => void;
}) {
  const { t, lang } = useTranslation();
  const newRowRef = useRef<HTMLDivElement | null>(null);
  const [capsEl, setCapsEl] = useState<HTMLDivElement | null>(null);
  const [newRowWidth, setNewRowWidth] = useState<number>();
  // B-836: phone-only entries (反馈) never take a desktop row — 帮助 in the footer reaches them.
  const rowEntries = props.capabilities.filter((e) => !e.phoneOnly);
  const fit = useCapabilityFit(props.listRef, capsEl, rowEntries.length);
  if (props.actions.length === 0) return null;
  const { shown, folded } = splitCapabilities(rowEntries, fit);
  const foldedAttention = navAttentionTotal(folded);
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
      {props.capabilities.length > 0 && <div className="sb-caps" ref={setCapsEl} role="group" aria-label={t('sidebar.capabilities')}>
        {shown.map((e) => {
          const Icon = navIcon[e.key];
          return (
            <button key={e.key} type="button" className="sb-nav-btn sb-cap" data-cap={e.key} onClick={() => props.onNavigate(e.path)} aria-label={navMenuLabel(props.capabilityNames[e.key], e.attention)}>
              <Icon size={17} /><span>{props.capabilityNames[e.key]}</span><AttentionBadge count={e.attention} tone={e.tone} />
            </button>
          );
        })}
        {folded.length > 0 && (
          <ActionDropdownMenu align="start" sideOffset={4} items={capabilityMenuItems(folded, props.capabilityNames, props.onNavigate)}>
            <button type="button" className="sb-nav-btn sb-cap sb-caps-more" aria-label={navMenuLabel(t('sidebar.moreCapabilities'), foldedAttention)}>
              <LayoutGrid size={17} /><span>{t('sidebar.moreCapabilities')}</span><AttentionBadge count={foldedAttention} /><ChevronDown size={14} className="sb-caps-chevron" />
            </button>
          </ActionDropdownMenu>
        )}
      </div>}
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
  return (
    <div className="sb-chips">
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
