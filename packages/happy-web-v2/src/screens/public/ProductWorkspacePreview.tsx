import {
  AudioLines,
  ArrowLeft,
  Check,
  ChevronRight,
  Clock,
  Copy,
  EyeOff,
  FileText,
  FolderOpen,
  Folder,
  HelpCircle,
  LayoutGrid,
  Maximize2,
  MessageSquare,
  MessagesSquare,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SendHorizontal,
  Settings,
  StickyNote,
  TerminalSquare,
  X,
} from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

// These are the production stylesheets, not a parallel marketing skin. The
// preview deliberately uses the same DOM/class contracts as Sidebar,
// WebTerminalScreen, FsBrowser, SessionDetailScreen, MessageView and the Task
// Board. It stays data-only so anonymous routes never pull sync/auth/socket
// code into the public bundle.
import '../sessions/sidebar.css';
import '../terminal/terminal.css';
import '../files/fsbrowser.css';
import '../session/session.css';
import '../session/header.css';
import '../session/message.css';
import '../session/code.css';
import '../session/mirror.css';
import '../session/toolgroup.css';
import '../board/board.css';
import '../../ui/ui.css';
import { useImeGuard } from '../../utils/ime';
import './productWorkspacePreview.css';
import { getProductPreviewIds, type ProductPreviewView } from './productPreviewIds';

const VIEW_LABELS: Record<ProductPreviewView, string> = {
  terminal: 'terminal and files',
  conversation: 'structured conversation',
  board: 'task board',
};

export function ProductWorkspacePreview({
  compact = false,
  initialView,
  sidebar = true,
}: {
  compact?: boolean;
  initialView?: ProductPreviewView;
  sidebar?: boolean;
}) {
  const [view, setView] = useState<ProductPreviewView>(initialView ?? (compact ? 'conversation' : 'terminal'));
  const [filesOpen, setFilesOpen] = useState(true);
  const [workspaceNavOpen, setWorkspaceNavOpen] = useState(false);
  const instanceId = useId();
  const ids = getProductPreviewIds(instanceId);
  const productRef = useRef<HTMLDivElement | null>(null);
  const focusInsideProduct = (selector: string) => {
    window.requestAnimationFrame(() => productRef.current?.querySelector<HTMLElement>(selector)?.focus());
  };
  const showTerminal = (openFiles = false) => {
    setWorkspaceNavOpen(false);
    setView('terminal');
    setFilesOpen(openFiles);
    focusInsideProduct(openFiles ? '[aria-label="Close files and return to terminal"]' : '[aria-label="Open structured Claude mirror"]');
  };
  const openStructured = () => {
    setWorkspaceNavOpen(false);
    setView('conversation');
    focusInsideProduct('.mrb-term-btn');
  };
  const openBoard = () => {
    setWorkspaceNavOpen(false);
    setView('board');
    focusInsideProduct('.bd .vh-back');
  };
  const openWorkspaceNav = () => {
    const sidebarElement = productRef.current?.querySelector<HTMLElement>('.product-sidebar');
    if (sidebarElement && window.getComputedStyle(sidebarElement).display !== 'none') {
      sidebarElement.querySelector<HTMLElement>('[data-product-session]')?.focus();
      return;
    }
    setWorkspaceNavOpen(true);
    focusInsideProduct('[data-product-session]');
  };
  const closeWorkspaceNav = () => {
    setWorkspaceNavOpen(false);
    focusInsideProduct('.product-detail .vh-back');
  };

  return (
    <div className={`product-preview${compact ? ' product-preview--compact' : ''}`}>
      <span className="sr-only" aria-live="polite">Showing the sanitized {VIEW_LABELS[view]} preview.</span>
      <div
        ref={productRef}
        id={ids.panel}
        className={`product-app${!sidebar ? ' product-app--no-sidebar' : ''}${workspaceNavOpen ? ' product-app--nav-open' : ''}`}
        role="group"
        aria-label={`Interactive sanitized ${VIEW_LABELS[view]} product preview`}
      >
        {sidebar && <ProductSidebar active={view} onTerminal={() => showTerminal(false)} onBoard={openBoard} onCloseNav={closeWorkspaceNav} />}
        <div className="product-detail">
          {view === 'terminal' && <TerminalAndFiles filesId={ids.files} filesOpen={filesOpen} onBack={openWorkspaceNav} onCloseFiles={() => setFilesOpen(false)} onOpenFiles={() => setFilesOpen(true)} onStructured={openStructured} />}
          {view === 'conversation' && <Conversation onBack={openWorkspaceNav} onFiles={() => showTerminal(true)} onReturn={() => showTerminal(false)} />}
          {view === 'board' && <Board onBack={openWorkspaceNav} onOpenSession={(target) => target === 'terminal' ? showTerminal(false) : openStructured()} />}
        </div>
      </div>
    </div>
  );
}

function ProductSidebar({ active, onTerminal, onBoard, onCloseNav }: { active: ProductPreviewView; onTerminal: () => void; onBoard: () => void; onCloseNav: () => void }) {
  const rows = [
    { icon: TerminalSquare, title: 'Release candidate', meta: 'claude · working', selected: active === 'terminal' || active === 'conversation', live: true },
    { icon: MessageSquare, title: 'Onboarding polish', meta: 'codex · 14m', selected: false },
    { icon: MessageSquare, title: 'Security review', meta: 'claude · waiting', attention: true },
    { icon: TerminalSquare, title: 'Docs structure', meta: 'workstation · 1h', selected: false },
  ];
  return (
    <aside className="product-sidebar" aria-label="Example session sidebar">
      <div className="sb">
        <header className="sb-header">
          <div className="sb-brand"><strong>Very Happy</strong></div>
          <div className="sb-header-right">
            <button className="sb-icon-btn" type="button" aria-label="Search" disabled><Search size={16} /></button>
            <button className="sb-icon-btn" type="button" aria-label="Voice assistant" disabled><AudioLines size={16} /></button>
            <button className="sb-icon-btn sb-board-btn" type="button" aria-label="Open task board" aria-pressed={active === 'board'} onClick={onBoard}><LayoutGrid size={16} /><span className="sb-board-badge mono">1</span></button>
            <button className="sb-icon-btn product-nav-close" type="button" aria-label="Close session list" onClick={onCloseNav}><PanelLeftClose size={16} /></button>
            <button className="sb-icon-btn" type="button" aria-label="New session" disabled><Plus size={17} /></button>
          </div>
        </header>
        <div className="sb-filter" role="presentation"><button className="sb-filter-btn is-on" type="button" disabled>LIST</button><button className="sb-filter-btn" type="button" disabled>STATUS</button><button className="sb-filter-btn" type="button" disabled>ARCHIVED</button></div>
        <div className="sb-list">
          <div className="sb-section">
            {rows.map(({ icon: Icon, title, meta, selected, attention, live }) => (
              <div key={title} className={`sb-row${selected ? ' is-selected' : ''}${attention ? ' sb-row--attention' : ''}`}>
                <button type="button" className="sb-row-main" data-product-session={title === 'Release candidate' ? '' : undefined} disabled={title !== 'Release candidate'} onClick={title === 'Release candidate' ? onTerminal : undefined}>
                  <span className={`sb-row-icon${Icon === TerminalSquare ? ' sb-row-icon--term' : ''}`}>{Icon === TerminalSquare && live ? <span className="sb-row-term-icon"><Icon size={16} /><span className="sb-row-agent-dot"><span className="vh-dot vh-dot--thinking vh-dot--pulse product-agent-dot" role="img" aria-label="Working" /></span></span> : <Icon size={16} />}</span>
                  <span className="sb-row-text"><span className="sb-row-title-line"><span className="sb-row-title">{title}</span></span><span className="sb-row-sub mono">{meta}</span></span>
                  {attention && <span className="sb-row-signal sb-row-signal--attention" />}
                </button>
                <button type="button" className="sb-row-menu" aria-label={`${title} actions`} disabled><MoreHorizontal size={16} /></button>
              </div>
            ))}
          </div>
        </div>
        <footer className="sb-footer"><button className="sb-footer-btn" type="button" disabled><Settings size={15} /> Settings</button></footer>
      </div>
    </aside>
  );
}

function TerminalAndFiles({ filesId, filesOpen, onBack, onCloseFiles, onOpenFiles, onStructured }: { filesId: string; filesOpen: boolean; onBack: () => void; onCloseFiles: () => void; onOpenFiles: () => void; onStructured: () => void }) {
  const filesButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const openFiles = () => {
    onOpenFiles();
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());
  };
  const closeFiles = () => {
    onCloseFiles();
    window.requestAnimationFrame(() => filesButtonRef.current?.focus());
  };
  const keepOverlayFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || window.getComputedStyle(event.currentTarget).position !== 'absolute') return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'))
      .filter((element) => !element.closest('[inert]'));
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <><p className="sr-only">A running Claude process in a durable terminal beside its project file browser and source preview.</p><div className="term-screen">
      <header className="term-header">
        <button className="vh-back" type="button" aria-label="Open session list" onClick={onBack}><ArrowLeft size={18} /></button>
        <button className="term-title" type="button" disabled><span className="term-title-text">Release candidate</span><Pencil size={13} className="term-title-edit" /></button>
        <div className="term-header-right">
          <button className="sb-icon-btn" type="button" aria-label="Open structured Claude mirror" onClick={onStructured}><MessagesSquare size={18} /></button>
          <button className="sb-icon-btn" type="button" aria-label="Notes" disabled><StickyNote size={18} /></button>
          <button ref={filesButtonRef} className={`sb-icon-btn${filesOpen ? ' is-active' : ''}`} type="button" aria-label="Open files" aria-controls={filesId} aria-expanded={filesOpen} onClick={openFiles}><FolderOpen size={18} /></button>
          <button className="sb-icon-btn" type="button" aria-label="Terminal help" disabled><HelpCircle size={18} /></button>
        </div>
      </header>
      <div className="term-mid">
        <div className="term-host">
          <div className="term-host-inner product-xterm" aria-label="Sanitized Claude terminal">
            <div><span className="product-xterm-prompt">❯</span> claude --resume release-candidate</div>
            <div className="product-xterm-gap" />
            <div>• Auditing onboarding and mobile flows…</div>
            <div className="product-xterm-gap" />
            <div><span className="product-xterm-ok">✓</span> fixed iOS input zoom</div>
            <div><span className="product-xterm-ok">✓</span> full test suite passed</div>
            <div><span className="product-xterm-ok">✓</span> production bundle built</div>
            <div className="product-xterm-gap" />
            <div>• Reviewing <span className="product-xterm-file">src/screens/public/</span></div>
            <div className="product-xterm-dim">  Opening LandingScreen.tsx<span className="product-xterm-cursor">▋</span></div>
          </div>
        </div>
        {filesOpen && <aside id={filesId} className="term-files product-term-files" onKeyDown={keepOverlayFocus}>
          <div className="term-files-head"><span className="term-files-title">Files</span><button ref={closeButtonRef} type="button" className="sb-icon-btn" aria-label="Close files and return to terminal" onClick={closeFiles}><X size={16} /></button></div>
          <FileWorkspace />
        </aside>}
      </div>
    </div></>
  );
}

type PreviewFile = 'LandingScreen.tsx' | 'README.md' | 'public.css';

const PREVIEW_FILE_CONTENT: Record<PreviewFile, string> = {
  'LandingScreen.tsx': `import { ProductWorkspacePreview } from './ProductWorkspacePreview';

export function LandingScreen() {
  return (
    <PublicLayout>
      <Hero
        eyebrow="WORKSPACE CONTINUITY"
        title="Work anywhere. Keep the thread."
      />
      <section id="product">
        <ProductWorkspacePreview />
      </section>
      <TrustModel />
      <QuickStart />
    </PublicLayout>
  );
}`,
  'README.md': `# Very Happy

Work anywhere. Keep the thread.

- Durable browser terminals
- Structured Claude conversation
- Files, previews, diffs, and tools
- Task board across sessions
- Claude, Codex, Gemini, OpenClaw

The relay is trusted infrastructure;
traffic is not end-to-end encrypted.`,
  'public.css': `.pub-page {
  min-height: 100%;
  background: var(--bg-0);
  color: var(--text);
}

.pub-hero-product {
  border: 1px solid var(--line-2);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-pop);
}

@media (prefers-reduced-motion: reduce) {
  .pub-page::after { animation: none; }
}`,
};

function FileWorkspace() {
  const [file, setFile] = useState<PreviewFile | null>('LandingScreen.tsx');
  const lastFile = useRef<PreviewFile>('LandingScreen.tsx');
  const focusTarget = useRef<'preview' | 'list' | null>(null);
  const backButtonRef = useRef<HTMLButtonElement | null>(null);
  const fileButtonRefs = useRef<Record<PreviewFile, HTMLButtonElement | null>>({
    'LandingScreen.tsx': null,
    'README.md': null,
    'public.css': null,
  });

  useLayoutEffect(() => {
    const target = focusTarget.current;
    if (!target) return;
    if (target === 'preview') backButtonRef.current?.focus();
    else fileButtonRefs.current[lastFile.current]?.focus();
    focusTarget.current = null;
  }, [file]);

  const openFile = (name: PreviewFile) => {
    lastFile.current = name;
    focusTarget.current = 'preview';
    setFile(name);
  };
  const closeFile = () => {
    focusTarget.current = 'list';
    setFile(null);
  };

  if (file) return <FilePreview file={file} onBack={closeFile} backButtonRef={(element) => { backButtonRef.current = element; }} />;
  return (
    <div className="fsb product-file-list">
      <div className="fsb-bar">
        <nav className="fsb-crumbs mono" aria-label="Example file breadcrumbs">
          <span className="fsb-crumb-seg">
            <span className="fsb-crumb">~</span><span className="fsb-crumb-sep">/</span>
            <span className="fsb-crumb">very-happy</span><span className="fsb-crumb-sep">/</span>
            <span className="fsb-crumb is-current" aria-current="location">public</span>
          </span>
        </nav>
        <span inert><button type="button" className="fsb-iconbtn" aria-label="Sort by time"><Clock size={14} /></button><button type="button" className="fsb-iconbtn" aria-label="Show hidden files"><EyeOff size={14} /></button><button type="button" className="fsb-iconbtn" aria-label="Refresh"><RefreshCw size={14} /></button></span>
      </div>
      <div className="fsb-list">
        <div className="fsb-row"><Folder size={13} className="fsb-icon fsb-icon--dir" /><span className="fsb-name">components</span><span className="fsb-meta mono" /><span className="fsb-meta fsb-meta--time mono">08/24 10:42</span></div>
        {(Object.keys(PREVIEW_FILE_CONTENT) as PreviewFile[]).map((name) => (
          <button key={name} ref={(element) => { fileButtonRefs.current[name] = element; }} type="button" className="fsb-row" onClick={() => openFile(name)}>
            <FileText size={13} className="fsb-icon" /><span className="fsb-name">{name}</span><span className="fsb-meta mono">{name.endsWith('.md') ? '9 KB' : '18 KB'}</span><span className="fsb-meta fsb-meta--time mono">08/24 10:38</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function FilePreview({ file, onBack, backButtonRef }: { file: PreviewFile; onBack: () => void; backButtonRef: (element: HTMLButtonElement | null) => void }) {
  return <div className="fsb-viewer product-file-preview"><div className="fsb-viewer-head"><span className="fsb-viewer-path">~/code/very-happy/src/screens/public/{file}</span><span inert><button type="button" className="fsb-iconbtn" aria-label="Copy path"><Copy size={14} /></button><button type="button" className="fsb-iconbtn" aria-label="Fullscreen"><Maximize2 size={14} /></button></span><button ref={backButtonRef} type="button" className="fsb-iconbtn" aria-label="Back to file list" onClick={onBack}><ArrowLeft size={15} /></button></div><div className="fsb-viewer-body"><div className="cv"><div className="cv-bar"><span className="cv-lang">{file.split('.').pop()}</span><span className="cv-copy mono">SANITIZED</span></div><div className="cv-body"><pre className="cv-pre"><code>{PREVIEW_FILE_CONTENT[file]}</code></pre></div></div></div></div>;
}

function Conversation({ onBack, onFiles, onReturn }: { onBack: () => void; onFiles: () => void; onReturn: () => void }) {
  const demoNoteId = useId();
  const ime = useImeGuard();
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const send = () => {
    const next = draft.trim();
    if (!next) return;
    setSent(next);
    setDraft('');
  };
  return <div className="sd"><div className="sd-main"><header className="ch"><button className="vh-back" type="button" aria-label="Open session list" onClick={onBack}><ArrowLeft size={18} /></button><div className="ch-main"><button type="button" className="ch-title-btn" disabled><span className="ch-title">Release candidate</span><Pencil size={13} className="ch-title-pencil" /></button><div className="ch-crumb"><span className="ch-crumb-host">workstation</span><span className="ch-crumb-sep">·</span><span className="ch-crumb-cwd">~/code/very-happy</span></div></div><div className="ch-status"><button className="ch-icon" type="button" aria-label="Open files" onClick={onFiles}><FolderOpen size={17} /></button></div></header><div className="mrb"><div className="mrb-note" role="note"><span className="mrb-note-text">Optional terminal hooks installed · demo input stays local</span><span className="mrb-meter mono">38k · 81% left</span><button type="button" className="mrb-term-btn mono" onClick={onReturn}><TerminalSquare size={13} /><span>Back to terminal</span></button></div></div><div className="sd-body product-chat"><div className="msg msg--user"><div className="msg-bubble">Can I leave the terminal while the release check keeps running?</div></div><div className="msg msg--agent"><div className="msg-agent-text">Yes. This structured view follows the active Claude terminal binding, including tool activity and results.</div></div><ToolActivityProof /><div className="msg msg--agent"><div className="msg-agent-text">The process is still live. Use “Back to terminal” when the raw TUI needs your attention.</div></div>{sent && <div className="msg msg--user"><div className="msg-bubble">{sent}</div></div>}</div><div className="mri"><span id={demoNoteId} className="sr-only">Local public-page preview. This text is not sent or stored.</span><textarea className="mri-input" rows={1} value={draft} placeholder="LOCAL PREVIEW · NOT SENT" aria-label="Add a message to the local preview; nothing is sent" aria-describedby={demoNoteId} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !ime.isGuarded(event)) { event.preventDefault(); send(); } }} onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd} /><button type="button" className="mri-send" aria-label="Add message to local preview; nothing is sent" disabled={!draft.trim()} onClick={() => { if (!ime.isComposing()) send(); }}><SendHorizontal size={16} /></button></div></div></div>;
}

function ToolActivityProof() {
  const [open, setOpen] = useState(false);
  return <div className="tg tg--done"><div className="tg-spine" aria-hidden="true" /><div className="tg-content"><div className="tg-row"><div className="tg-row-head-wrap"><button type="button" className="tg-row-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}><ChevronRight size={13} className={`tg-chevron${open ? ' is-open' : ''}`} /><span className="vh-dot vh-dot--connected" aria-hidden="true" /><span className="tg-tool-label">Edit</span></button><span className="tg-tool-detail">styles/base.css</span></div>{open && <div className="tg-body"><div className="cv product-diff"><div className="cv-bar"><span className="cv-lang">diff</span><span className="cv-copy mono">SANITIZED</span></div><div className="cv-body"><pre className="cv-pre"><code>{'- font-size: var(--fs-14);\n+ font-size: var(--fs-16);'}</code></pre></div></div></div>}</div></div></div>;
}

function Board({ onBack, onOpenSession }: { onBack: () => void; onOpenSession: (target: 'terminal' | 'conversation') => void }) {
  const [completed, setCompleted] = useState<string[]>([]);
  const columns = [
    { title: 'WORKING', cards: [['Landing product proof', 'workstation', 'Reusing product UI contracts.']] },
    { title: 'WAITING ON ME', attention: true, cards: [['Approve production release', 'human judgment', 'All quality gates passed.']] },
    { title: 'DONE', cards: [['Security boundary review', 'review-node', 'Trusted relay language verified.']] },
  ];
  const openCard = (column: string) => onOpenSession(column === 'WORKING' ? 'terminal' : 'conversation');
  return <><p className="sr-only">A three-column task board showing work in progress, one release decision waiting for human judgment, and a completed security review.</p><div className="bd"><header className="bd-header"><button className="vh-back" type="button" aria-label="Open session list" onClick={onBack}><ArrowLeft size={18} /></button><span className="bd-title">Task board</span><span className="bd-summary-attn">1 needs you</span></header><div className="bd-cols">{columns.map((column) => <section key={column.title} className={`bd-col${column.attention ? ' bd-col--attention' : ''}`}><header className="bd-col-head"><span className="bd-col-label eyebrow">{column.title}</span><span className="bd-col-count mono">{column.cards.length}</span></header><div className="bd-col-list">{column.cards.map(([title, machine, progress]) => { const isDone = completed.includes(title); return <div key={title} className={`bd-card bd-card--${column.attention ? 'attention' : column.title === 'WORKING' ? 'working' : 'idle'}${isDone ? ' bd-card--ended' : ''}`} role="button" tabIndex={0} aria-label={`Open ${title}`} onClick={() => openCard(column.title)} onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openCard(column.title); } }}><div className="bd-card-head"><span className={`product-status-dot${column.title === 'WORKING' && !isDone ? ' is-live' : ''}${column.attention && !isDone ? ' is-attention' : ''}`} /><span className="bd-card-title">{title}</span><button type="button" className="bd-card-done" aria-label={isDone ? `${title} marked done` : `Mark ${title} done`} aria-pressed={isDone} onClick={(event) => { event.stopPropagation(); setCompleted((items) => items.includes(title) ? items.filter((item) => item !== title) : [...items, title]); }}><Check size={13} /></button><MessageSquare size={14} className="bd-card-kind" /></div><div className="bd-card-meta mono"><span className="bd-card-machine">{machine}</span><span className="bd-card-cwd">~/code/very-happy</span></div><div className="bd-card-progress">{isDone ? 'Marked done in this local demo.' : progress}</div><div className="bd-card-foot mono"><span className="bd-card-time">2m ago</span></div></div>; })}</div></section>)}</div></div></>;
}
