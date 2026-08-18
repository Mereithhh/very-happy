import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isAppChord } from '@/app/appChord';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Search,
  Plus,
  Settings,
  TerminalSquare,
  MessageSquare,
  Pencil,
  Archive,
  ClipboardList,
  StickyNote,
  AudioLines,
  ListChecks,
  FolderOpen,
} from 'lucide-react';
import { useSessions } from '@/sync/storage';
import { isHiddenSession } from '@/assistant/assistantSession';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { getSessionName, getSessionSubtitle } from '@/utils/sessionUtils';
import { createTerminalOrPick, NEW_TERMINAL_SHORTCUT_HINT } from '@/app/newTerminal';
import { createChatOrConfigure } from '@/app/newChat';
import { sessionUpdateTitle, sessionArchive } from '@/sync/ops';
import { nextSessionPathAfterClose } from '@/app/rowActions';
import { Modal } from '@/modal';
import { useTranslation } from '@/i18n/useTranslation';
import { useImeGuard } from '@/utils/ime';
import { NewSessionModal } from '@/screens/sessions/NewSessionModal';
import { NewTerminalModal } from '@/screens/sessions/NewTerminalModal';
import { openClipboardHistory } from '@/screens/clipboard/ClipboardHistoryPanel';
import { toggleNotesPanel } from '@/screens/notes/notesPanelState';
import {
  parseSidebarQuery,
  sidebarQueryIsEmpty,
  tagsMatchSidebarQuery,
} from '@/screens/sessions/sidebarSearch';
import './commandpalette.css';

/**
 * Programmatic open — the palette owns its open state; UI entry points that
 * can't press ⌘K (the sidebar's coarse-pointer search icon) dispatch this
 * event instead. Window event, not a store: the palette is a singleton and
 * nothing else needs to observe the state.
 */
const OPEN_EVENT = 'vh:command-palette-open';
export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

type CommandItem = {
  key: string;
  group: 'actions' | 'sessions' | 'terminals';
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  /** lower-cased haystack for substring matching */
  haystack: string;
  /** session tags — `#tag` query terms filter on these (sidebar grammar) */
  tags?: string[];
  /** optional keyboard-shortcut hint rendered on the row's right edge */
  hint?: string;
  run: () => void | Promise<void>;
};

/** simple case-insensitive substring match; score = match position (lower = better, -1 = no match) */
function matchScore(haystack: string, q: string): number {
  if (!q) return 0;
  return haystack.indexOf(q);
}

export function CommandPalette() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ime = useImeGuard();
  const [active, setActive] = useState(0);
  const [showNewSession, setShowNewSession] = useState(false);
  const [showNewTerminal, setShowNewTerminal] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const sessions = useSessions();
  const terminals = useTerminalSessions((s) => s.terminals);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActive(0);
  }, []);

  // current session id from the route (/session/:id)
  const currentSessionId = useMemo(() => {
    const m = location.pathname.match(/^\/session\/([^/]+)/);
    return m ? m[1] : null;
  }, [location.pathname]);

  // ── global ⌘K / Ctrl+K listener (capture phase + preventDefault) ──
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // isAppChord（不是 metaKey||ctrlKey）：macOS 上 Ctrl+K 是终端 readline 的
      // kill-line，不能被 app 截走（2026-08-14 golden 差分实测坐实）。
      if (isAppChord(e) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        e.stopPropagation();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown, true); // capture
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // programmatic open (sidebar's mobile search icon)
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  // focus input on open
  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // one online machine → direct create; 0 / >1 → picker (shared entry point)
  const openNewTerminal = useCallback(() => createTerminalOrPick(navigate), [navigate]);

  const renameCurrent = useCallback(async () => {
    if (!currentSessionId) return;
    const current = (sessions ?? []).find(
      (s): s is Exclude<typeof s, string> => typeof s !== 'string' && s.id === currentSessionId,
    );
    const defaultValue = current ? getSessionName(current) : '';
    const next = await Modal.prompt(
      t('commandPalette.renamePromptTitle'),
      undefined,
      { defaultValue },
    );
    if (next != null && next.trim()) {
      await sessionUpdateTitle(currentSessionId, next.trim());
    }
  }, [currentSessionId, sessions, t]);

  const archiveCurrent = useCallback(async () => {
    if (!currentSessionId) return;
    await sessionArchive(currentSessionId);
    // B-111: leave the archived detail view onto the next session.
    navigate(nextSessionPathAfterClose(currentSessionId));
  }, [currentSessionId, navigate]);

  // ── build the full item index (unfiltered) ──
  const items = useMemo<CommandItem[]>(() => {
    const out: CommandItem[] = [];

    // Actions
    out.push({
      key: 'action:new-terminal',
      group: 'actions',
      title: t('commandPalette.actionNewTerminal'),
      icon: <TerminalSquare size={16} />,
      haystack: (t('commandPalette.actionNewTerminal') as string).toLowerCase(),
      hint: NEW_TERMINAL_SHORTCUT_HINT,
      run: openNewTerminal,
    });
    out.push({
      // B-144: the deliberate variant — choose the working directory first, so
      // the configured startup command starts in the project, not in $HOME.
      key: 'action:new-terminal-at',
      group: 'actions',
      title: t('commandPalette.actionNewTerminalAt'),
      icon: <FolderOpen size={16} />,
      haystack: `terminal directory cwd ${(t('commandPalette.actionNewTerminalAt') as string).toLowerCase()}`,
      run: () => setShowNewTerminal(true),
    });
    out.push({
      key: 'action:new-chat',
      group: 'actions',
      title: t('commandPalette.actionNewChat'),
      icon: <Plus size={16} />,
      haystack: (t('commandPalette.actionNewChat') as string).toLowerCase(),
      // Quick create (same flow as the sidebar "+"): spawn directly, fall
      // back to the full dialog only when the quick path can't decide.
      run: () => void createChatOrConfigure(navigate, () => setShowNewSession(true)),
    });
    out.push({
      key: 'action:new-chat-advanced',
      group: 'actions',
      title: t('commandPalette.actionNewChatAdvanced'),
      icon: <MessageSquare size={16} />,
      haystack: (t('commandPalette.actionNewChatAdvanced') as string).toLowerCase(),
      run: () => setShowNewSession(true),
    });
    if (currentSessionId) {
      out.push({
        key: 'action:rename',
        group: 'actions',
        title: t('commandPalette.actionRenameSession'),
        icon: <Pencil size={16} />,
        haystack: (t('commandPalette.actionRenameSession') as string).toLowerCase(),
        run: renameCurrent,
      });
      out.push({
        key: 'action:archive',
        group: 'actions',
        title: t('commandPalette.actionArchiveSession'),
        icon: <Archive size={16} />,
        haystack: (t('commandPalette.actionArchiveSession') as string).toLowerCase(),
        run: archiveCurrent,
      });
    }
    out.push({
      key: 'action:assistant',
      group: 'actions',
      title: t('commandPalette.actionAssistant'),
      icon: <AudioLines size={16} />,
      haystack: (t('commandPalette.actionAssistant') as string).toLowerCase(),
      run: () => navigate('/assistant'),
    });
    out.push({
      key: 'action:clipboard-history',
      group: 'actions',
      title: t('commandPalette.actionClipboardHistory'),
      icon: <ClipboardList size={16} />,
      haystack: (t('commandPalette.actionClipboardHistory') as string).toLowerCase(),
      run: openClipboardHistory,
    });
    out.push({
      key: 'action:notes',
      group: 'actions',
      title: t('commandPalette.actionNotes'),
      icon: <StickyNote size={16} />,
      haystack: `notes ${(t('commandPalette.actionNotes') as string).toLowerCase()}`,
      hint: '⌘J',
      run: toggleNotesPanel,
    });
    out.push({
      key: 'action:notes-all',
      group: 'actions',
      title: t('commandPalette.actionAllNotes'),
      icon: <StickyNote size={16} />,
      haystack: `notes ${(t('commandPalette.actionAllNotes') as string).toLowerCase()}`,
      run: () => navigate('/notes'),
    });
    out.push({
      key: 'action:todos',
      group: 'actions',
      title: t('commandPalette.actionTodos'),
      icon: <ListChecks size={16} />,
      haystack: `todos todo ${(t('commandPalette.actionTodos') as string).toLowerCase()}`,
      run: () => navigate('/todos'),
    });
    out.push({
      key: 'action:settings',
      group: 'actions',
      title: t('commandPalette.actionOpenSettings'),
      icon: <Settings size={16} />,
      haystack: (t('commandPalette.actionOpenSettings') as string).toLowerCase(),
      run: () => navigate('/settings'),
    });

    // Sessions (nav) — filter out section-header strings from the legacy list
    for (const s of sessions ?? []) {
      if (typeof s === 'string') continue;
      // B-091/B-105 belt-and-braces: sessionsData already excludes hidden
      // sessions (assistant, terminal mirrors) at the source; keep the
      // predicate here so a storage-lane refactor can't leak them into search.
      if (isHiddenSession(s)) continue;
      const title = getSessionName(s);
      const sub = getSessionSubtitle(s);
      const path = s.metadata?.path ?? '';
      out.push({
        key: `session:${s.id}`,
        group: 'sessions',
        title,
        subtitle: sub,
        icon: <MessageSquare size={16} />,
        haystack: `${title} ${sub} ${path}`.toLowerCase(),
        tags: s.metadata?.tags,
        run: () => navigate(`/session/${s.id}`),
      });
    }

    // Terminals (nav)
    for (const term of terminals) {
      const sub = term.machineName;
      out.push({
        key: `terminal:${term.id}`,
        group: 'terminals',
        title: term.title,
        subtitle: sub,
        icon: <TerminalSquare size={16} />,
        haystack: `${term.title} ${sub}`.toLowerCase(),
        run: () => navigate(`/terminal/${term.machineId}?tid=${term.id}`),
      });
    }

    return out;
  }, [
    sessions,
    terminals,
    currentSessionId,
    t,
    navigate,
    openNewTerminal,
    renameCurrent,
    archiveCurrent,
  ]);

  // ── filter + sort by match position (actions always kept above nav on ties) ──
  // The sidebar's `#tag` grammar applies here too (the search box the palette
  // replaced supported it): `#foo` terms AND-filter on session tags, the
  // free-text remainder keeps the substring match over the haystack. Items
  // without tags (actions, terminals) simply fail any tag constraint.
  const filtered = useMemo(() => {
    const parsed = parseSidebarQuery(query);
    if (sidebarQueryIsEmpty(parsed)) return items;
    const groupOrder: Record<CommandItem['group'], number> = { actions: 0, sessions: 1, terminals: 2 };
    return items
      .filter((it) => tagsMatchSidebarQuery(it.tags, parsed))
      .map((it) => ({ it, score: matchScore(it.haystack, parsed.text) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || groupOrder[a.it.group] - groupOrder[b.it.group])
      .map((x) => x.it);
  }, [items, query]);

  // keep active index in bounds when the list changes
  useEffect(() => {
    setActive((a) => (filtered.length === 0 ? 0 : Math.min(a, filtered.length - 1)));
  }, [filtered.length]);

  // scroll active item into view
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>('.cp-item.is-active');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const runItem = useCallback(
    async (item: CommandItem | undefined) => {
      if (!item) return;
      close();
      await item.run();
    },
    [close],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // IME guard: while a CJK composition is active, Enter/arrows/Escape
      // operate the candidate window — they must not run items, move the
      // selection, or close the palette.
      if (ime.isGuarded(e)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (filtered.length ? (a + 1) % filtered.length : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (filtered.length ? (a - 1 + filtered.length) % filtered.length : 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runItem(filtered[active]);
      }
    },
    [filtered, active, close, runItem, ime],
  );

  // render grouped list (dividers by group label)
  const groups = useMemo(() => {
    const labels: Record<CommandItem['group'], string> = {
      actions: t('commandPalette.groupActions'),
      sessions: t('commandPalette.groupSessions'),
      terminals: t('commandPalette.groupTerminals'),
    };
    const order: CommandItem['group'][] = ['actions', 'sessions', 'terminals'];
    // flat index → so highlight math stays aligned with `filtered`
    let flat = 0;
    return order
      .map((g) => {
        const rows = filtered.filter((it) => it.group === g);
        const mapped = rows.map((it) => ({ it, index: filtered.indexOf(it) }));
        flat += rows.length;
        return { group: g, label: labels[g], rows: mapped };
      })
      .filter((x) => x.rows.length > 0);
  }, [filtered, t]);

  return (
    <>
      {open && (
        <div
          className="cp-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div
            className="cp-panel"
            role="dialog"
            aria-modal="true"
            onKeyDown={onKeyDown}
            // Composition events bubble from the search input; tracking them
            // here keeps the panel-level key guard IME-aware.
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
          >
            <div className="cp-search">
              <Search size={16} className="cp-search-icon" />
              <input
                ref={inputRef}
                className="cp-search-input"
                type="text"
                value={query}
                placeholder={t('commandPalette.placeholder')}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>

            <div className="cp-list" ref={listRef}>
              {filtered.length === 0 ? (
                <div className="cp-empty">{t('commandPalette.empty')}</div>
              ) : (
                groups.map((grp) => (
                  <div key={grp.group}>
                    <div className="cp-group-label">{grp.label}</div>
                    {grp.rows.map(({ it, index }) => (
                      <button
                        key={it.key}
                        type="button"
                        className={`cp-item${index === active ? ' is-active' : ''}`}
                        onMouseMove={() => setActive(index)}
                        onClick={() => runItem(it)}
                      >
                        <span className="cp-item-icon">{it.icon}</span>
                        <span className="cp-item-text">
                          <span className="cp-item-title">{it.title}</span>
                          {it.subtitle ? <span className="cp-item-sub">{it.subtitle}</span> : null}
                        </span>
                        {it.hint ? <kbd className="cp-item-hint">{it.hint}</kbd> : null}
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>

            <div className="cp-footer">
              <span>{t('commandPalette.hintNavigate')}</span>
              <span>{t('commandPalette.hintSelect')}</span>
              <span>{t('commandPalette.hintClose')}</span>
            </div>
          </div>
        </div>
      )}

      {showNewSession && <NewSessionModal onClose={() => setShowNewSession(false)} />}
      {showNewTerminal && <NewTerminalModal onClose={() => setShowNewTerminal(false)} />}
    </>
  );
}
