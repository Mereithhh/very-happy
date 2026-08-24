import {
  ArrowLeft,
  AudioLines,
  Check,
  Command,
  FileClock,
  ListChecks,
  MessageSquare,
  Search,
  Settings,
  StickyNote,
  TerminalSquare,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { IS_MAC } from '../../app/appChord';
import { useImeGuard } from '../../utils/ime';
import { PUBLIC_COMMAND_PROOF_EVENT } from './publicContent';
import '../command/commandpalette.css';
import './keyboardWorkflowProof.css';

type DemoGroup = 'actions' | 'sessions' | 'terminals';
type DemoItem = {
  key: string;
  group: DemoGroup;
  title: string;
  subtitle?: string;
  hint?: string;
  icon: typeof TerminalSquare;
};

const DEMO_ITEMS: DemoItem[] = [
  { key: 'new-terminal', group: 'actions', title: 'New terminal', hint: IS_MAC ? '⌘N · ⌥N' : 'Ctrl+N · Alt+N', icon: TerminalSquare },
  { key: 'new-chat', group: 'actions', title: 'New chat', icon: MessageSquare },
  { key: 'voice', group: 'actions', title: 'Voice assistant', icon: AudioLines },
  { key: 'notes', group: 'actions', title: 'Notes panel', hint: IS_MAC ? '⌘J' : 'Ctrl+J', icon: StickyNote },
  { key: 'todos', group: 'actions', title: 'Todo list', icon: ListChecks },
  { key: 'settings', group: 'actions', title: 'Open settings', icon: Settings },
  { key: 'release', group: 'sessions', title: 'Release candidate', subtitle: 'workstation · ~/code/very-happy', icon: MessageSquare },
  { key: 'onboarding', group: 'sessions', title: 'Onboarding polish', subtitle: 'laptop · needs review', icon: MessageSquare },
  { key: 'deploy', group: 'terminals', title: 'Deploy check', subtitle: 'build-server', icon: TerminalSquare },
];

const GROUP_LABELS: Record<DemoGroup, string> = {
  actions: 'Actions',
  sessions: 'Chats',
  terminals: 'Terminals',
};

export function KeyboardWorkflowProof({ compact = false }: { compact?: boolean }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState('LOCAL DEMO · NOTHING RUNS');
  const [summoned, setSummoned] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const summonTimerRef = useRef<number | null>(null);
  const ime = useImeGuard();
  const listId = useId();
  const chordLabel = IS_MAC ? '⌘ K' : 'CTRL K';

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return DEMO_ITEMS;
    return DEMO_ITEMS.filter((item) => `${item.title} ${item.subtitle ?? ''}`.toLowerCase().includes(needle));
  }, [query]);

  const summon = useCallback(() => {
    setSummoned(true);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    sectionRef.current?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
    window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    if (summonTimerRef.current != null) window.clearTimeout(summonTimerRef.current);
    summonTimerRef.current = window.setTimeout(() => {
      summonTimerRef.current = null;
      setSummoned(false);
    }, 720);
  }, []);

  useEffect(() => {
    window.addEventListener(PUBLIC_COMMAND_PROOF_EVENT, summon);
    return () => {
      window.removeEventListener(PUBLIC_COMMAND_PROOF_EVENT, summon);
      if (summonTimerRef.current != null) window.clearTimeout(summonTimerRef.current);
    };
  }, [summon]);

  useEffect(() => {
    setActive((index) => filtered.length ? Math.min(index, filtered.length - 1) : 0);
  }, [filtered.length]);

  const run = (item: DemoItem | undefined) => {
    if (!item) return;
    setNotice(`DEMO ACTION · ${item.title.toUpperCase()}`);
  };

  const onPaletteKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (ime.isGuarded(event)) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => filtered.length ? (index + 1) % filtered.length : 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => filtered.length ? (index - 1 + filtered.length) % filtered.length : 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(filtered[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setQuery('');
      setNotice('LOCAL DEMO · NOTHING RUNS');
      inputRef.current?.blur();
    }
  };

  const groups = (Object.keys(GROUP_LABELS) as DemoGroup[])
    .map((group) => ({ group, rows: filtered.filter((item) => item.group === group) }))
    .filter(({ rows }) => rows.length);
  const activeItemId = filtered[active] ? `${listId}-${filtered[active].key}` : undefined;

  return <section id="keyboard-workflow" ref={sectionRef} className={`kwp${compact ? ' kwp--compact' : ''}${summoned ? ' is-summoned' : ''}`} aria-labelledby={compact ? 'kwp-docs-title' : 'kwp-title'}>
    <div className="kwp-layout"><div className="kwp-copy">
      <div className="eyebrow">KEYBOARD-FIRST · TOUCH-REACHABLE</div>
      <h2 id={compact ? 'kwp-docs-title' : 'kwp-title'}>Move at thought speed.<br /><span>Keep terminal muscle memory.</span></h2>
      <p><strong>{chordLabel}</strong> searches actions, chats, and terminals from anywhere in the workspace. On macOS, Very Happy leaves <code>Ctrl+K/J/N/R</code> to the real TUI; on touch screens, the sidebar search button opens the same command surface.</p>
      <button className="kwp-trigger" type="button" onClick={summon}>
        <span><Command size={18} aria-hidden="true" /> Try the command palette</span>
        <kbd>{chordLabel}</kbd>
      </button>
      <div className="kwp-shortcuts" aria-label="High-value Very Happy shortcuts">
        <div><kbd>⌘/Ctrl 1–9</kbd><span>switch visible sidebar work</span></div>
        <div><kbd>⌘/Ctrl .</kbd><span>open saved shortcuts</span></div>
        <div><kbd>⌘/Ctrl J</kbd><span>toggle notes</span></div>
        <div><kbd>⌘ [ · Alt ←</kbd><span>go back</span></div>
        <div><kbd>PWA ⌘/Ctrl N</kbd><span>new terminal · PC outside input</span></div>
        <div><kbd>Web Alt N</kbd><span>browser-safe fallback</span></div>
      </div>
      <p className="kwp-boundary">On macOS, an installed PWA can also receive <strong>⌘ W</strong> to close the current session with the product guard. Normal tabs keep browser-reserved shortcuts; <strong>Alt W</strong> is the cross-platform in-product fallback.</p>
    </div>

    <div className="kwp-stage" aria-label="Interactive sanitized command palette demonstration">
      <div className="kwp-grid" aria-hidden="true"><i /><i /><i /></div>
      <div className="kwp-orbit kwp-orbit--one" aria-hidden="true" />
      <div className="kwp-orbit kwp-orbit--two" aria-hidden="true" />
      <div className="kwp-key-reactor mono" aria-hidden="true"><span>{chordLabel}</span><i /></div>
      <div className="kwp-palette">
        <div className="kwp-surface-bar mono"><span><i /> PRODUCTION COMMAND PALETTE</span><span>SANITIZED DATA</span></div>
        <div className="cp-panel" onKeyDown={onPaletteKeyDown} onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd}>
          <div className="cp-search">
            <Search size={16} className="cp-search-icon" />
            <input ref={inputRef} className="cp-search-input" type="search" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={listId} aria-activedescendant={activeItemId} value={query} aria-label="Search the local command palette demo" placeholder="Type a command or search..." autoComplete="off" autoCorrect="off" spellCheck={false} onChange={(event) => { setQuery(event.target.value); setActive(0); }} />
          </div>
          <div id={listId} className="cp-list" role="listbox" aria-label="Sanitized command results">
            {!filtered.length ? <div className="cp-empty">No matches</div> : groups.map(({ group, rows }) => <div key={group} role="group" aria-label={GROUP_LABELS[group]}>
              <div className="cp-group-label" aria-hidden="true">{GROUP_LABELS[group]}</div>
              {rows.map((item) => {
                const index = filtered.indexOf(item);
                const Icon = item.icon;
                return <button key={item.key} id={`${listId}-${item.key}`} type="button" role="option" aria-selected={index === active} className={`cp-item${index === active ? ' is-active' : ''}`} onPointerMove={() => setActive(index)} onClick={() => run(item)}>
                  <span className="cp-item-icon"><Icon size={16} /></span>
                  <span className="cp-item-text"><span className="cp-item-title">{item.title}</span>{item.subtitle && <span className="cp-item-sub">{item.subtitle}</span>}</span>
                  {item.hint && <kbd className="cp-item-hint">{item.hint}</kbd>}
                </button>;
              })}
            </div>)}
          </div>
          <div className="cp-footer"><span>↑↓ navigate</span><span>↵ select</span><span>esc clear</span></div>
        </div>
        <div className="kwp-result mono" aria-live="polite"><Check size={13} aria-hidden="true" /> {notice}</div>
      </div>
      <div className="kwp-flow kwp-flow--left mono" aria-hidden="true"><ArrowLeft size={13} /> SESSION 03</div>
      <div className="kwp-flow kwp-flow--right mono" aria-hidden="true"><FileClock size={13} /> ONE SEARCH SURFACE</div>
    </div></div>
  </section>;
}
