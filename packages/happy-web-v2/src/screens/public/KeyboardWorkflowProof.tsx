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
import { usePublicI18n } from '../../i18n/publicI18n';
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

const ZH_ITEM_LABELS: Record<string, { title: string; subtitle?: string }> = {
  'new-terminal': { title: '新建终端' }, 'new-chat': { title: '新建对话' }, voice: { title: '语音助手' },
  notes: { title: '备忘录面板' }, todos: { title: '待办清单' }, settings: { title: '打开设置' },
  release: { title: '发布候选版', subtitle: 'workstation · ~/code/very-happy' },
  onboarding: { title: '打磨新手流程', subtitle: 'laptop · 待审核' },
  deploy: { title: '部署检查', subtitle: 'build-server' },
};

export function KeyboardWorkflowProof({ compact = false }: { compact?: boolean }) {
  const { language } = usePublicI18n();
  const zh = language === 'zh-Hans';
  const items = useMemo(() => DEMO_ITEMS.map((item) => zh ? { ...item, ...ZH_ITEM_LABELS[item.key] } : item), [zh]);
  const groupLabels: Record<DemoGroup, string> = zh ? { actions: '操作', sessions: '对话', terminals: '终端' } : GROUP_LABELS;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState(zh ? '本地演示 · 不会执行任何操作' : 'LOCAL DEMO · NOTHING RUNS');
  const [summoned, setSummoned] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const summonTimerRef = useRef<number | null>(null);
  const ime = useImeGuard();
  const listId = useId();
  const chordLabel = IS_MAC ? '⌘ K' : 'CTRL K';

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => `${item.title} ${item.subtitle ?? ''}`.toLowerCase().includes(needle));
  }, [items, query]);

  useEffect(() => setNotice(zh ? '本地演示 · 不会执行任何操作' : 'LOCAL DEMO · NOTHING RUNS'), [zh]);

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
    setNotice(`${zh ? '演示操作' : 'DEMO ACTION'} · ${zh ? item.title : item.title.toUpperCase()}`);
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
      setNotice(zh ? '本地演示 · 不会执行任何操作' : 'LOCAL DEMO · NOTHING RUNS');
      inputRef.current?.blur();
    }
  };

  const groups = (Object.keys(groupLabels) as DemoGroup[])
    .map((group) => ({ group, rows: filtered.filter((item) => item.group === group) }))
    .filter(({ rows }) => rows.length);
  const activeItemId = filtered[active] ? `${listId}-${filtered[active].key}` : undefined;

  return <section id="keyboard-workflow" ref={sectionRef} className={`kwp${compact ? ' kwp--compact' : ''}${summoned ? ' is-summoned' : ''}`} aria-labelledby={compact ? 'kwp-docs-title' : 'kwp-title'}>
    <div className="kwp-layout"><div className="kwp-copy">
      <div className="eyebrow">{zh ? '键盘优先 · 触屏可达' : 'KEYBOARD-FIRST · TOUCH-REACHABLE'}</div>
      <h2 id={compact ? 'kwp-docs-title' : 'kwp-title'}>{zh ? '跟上思考的速度。' : 'Move at thought speed.'}<br /><span>{zh ? '保留终端的肌肉记忆。' : 'Keep terminal muscle memory.'}</span></h2>
      <p><strong>{chordLabel}</strong>{zh ? '可以在工作区任意位置搜索操作、对话和终端。macOS 上，Very Happy 会把 ' : ' searches actions, chats, and terminals from anywhere in the workspace. On macOS, Very Happy leaves '}<code>Ctrl+K/J/N/R</code>{zh ? ' 留给真实 TUI；触屏上，侧栏搜索按钮会打开同一个命令界面。' : ' to the real TUI; on touch screens, the sidebar search button opens the same command surface.'}</p>
      <button className="kwp-trigger" type="button" onClick={summon}>
        <span><Command size={18} aria-hidden="true" /> {zh ? '试用命令面板' : 'Try the command palette'}</span>
        <kbd>{chordLabel}</kbd>
      </button>
      <div className="kwp-shortcuts" aria-label={zh ? 'Very Happy 常用快捷键' : 'High-value Very Happy shortcuts'}>
        <div><kbd>⌘/Ctrl 1–9</kbd><span>{zh ? '切换侧栏中可见的工作' : 'switch visible sidebar work'}</span></div>
        <div><kbd>⌘/Ctrl .</kbd><span>{zh ? '打开已保存快捷指令' : 'open saved shortcuts'}</span></div>
        <div><kbd>⌘/Ctrl J</kbd><span>{zh ? '切换备忘录' : 'toggle notes'}</span></div>
        <div><kbd>⌘ [ · Alt ←</kbd><span>{zh ? '返回' : 'go back'}</span></div>
        <div><kbd>PWA ⌘/Ctrl N</kbd><span>{zh ? '新建终端 · PC 上需不在输入框中' : 'new terminal · PC outside input'}</span></div>
        <div><kbd>Web Alt N</kbd><span>{zh ? '避开浏览器冲突的备选键' : 'browser-safe fallback'}</span></div>
      </div>
      <p className="kwp-boundary">{zh ? '在 macOS 上，已安装的 PWA 还可接收 ' : 'On macOS, an installed PWA can also receive '}<strong>⌘ W</strong>{zh ? '，并在产品保护下关闭当前会话。普通标签页保留浏览器快捷键；' : ' to close the current session with the product guard. Normal tabs keep browser-reserved shortcuts; '}<strong>Alt W</strong>{zh ? ' 是跨平台的产品内备选键。' : ' is the cross-platform in-product fallback.'}</p>
    </div>

    <div className="kwp-stage" aria-label={zh ? '可交互的脱敏命令面板演示' : 'Interactive sanitized command palette demonstration'}>
      <div className="kwp-grid" aria-hidden="true"><i /><i /><i /></div>
      <div className="kwp-orbit kwp-orbit--one" aria-hidden="true" />
      <div className="kwp-orbit kwp-orbit--two" aria-hidden="true" />
      <div className="kwp-key-reactor mono" aria-hidden="true"><span>{chordLabel}</span><i /></div>
      <div className="kwp-palette">
        <div className="kwp-surface-bar mono"><span><i /> {zh ? '生产命令面板' : 'PRODUCTION COMMAND PALETTE'}</span><span>{zh ? '脱敏数据' : 'SANITIZED DATA'}</span></div>
        <div className="cp-panel" onKeyDown={onPaletteKeyDown} onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd}>
          <div className="cp-search">
            <Search size={16} className="cp-search-icon" />
            <input ref={inputRef} className="cp-search-input" type="search" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={listId} aria-activedescendant={activeItemId} value={query} aria-label={zh ? '搜索本地命令面板演示' : 'Search the local command palette demo'} placeholder={zh ? '输入命令或搜索…' : 'Type a command or search...'} autoComplete="off" autoCorrect="off" spellCheck={false} onChange={(event) => { setQuery(event.target.value); setActive(0); }} />
          </div>
          <div id={listId} className="cp-list" role="listbox" aria-label={zh ? '脱敏命令结果' : 'Sanitized command results'}>
            {!filtered.length ? <div className="cp-empty">{zh ? '无匹配项' : 'No matches'}</div> : groups.map(({ group, rows }) => <div key={group} role="group" aria-label={groupLabels[group]}>
              <div className="cp-group-label" aria-hidden="true">{groupLabels[group]}</div>
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
          <div className="cp-footer"><span>↑↓ {zh ? '移动' : 'navigate'}</span><span>↵ {zh ? '选择' : 'select'}</span><span>esc {zh ? '清空' : 'clear'}</span></div>
        </div>
        <div className="kwp-result mono" aria-live="polite"><Check size={13} aria-hidden="true" /> {notice}</div>
      </div>
      <div className="kwp-flow kwp-flow--left mono" aria-hidden="true"><ArrowLeft size={13} /> SESSION 03</div>
      <div className="kwp-flow kwp-flow--right mono" aria-hidden="true"><FileClock size={13} /> ONE SEARCH SURFACE</div>
    </div></div>
  </section>;
}
