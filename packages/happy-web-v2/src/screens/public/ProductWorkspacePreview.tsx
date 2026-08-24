import {
  AudioLines,
  ArrowLeft,
  Check,
  Copy,
  FolderOpen,
  HelpCircle,
  LayoutGrid,
  Maximize2,
  MessageSquare,
  MessagesSquare,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Settings,
  StickyNote,
  TerminalSquare,
  X,
} from 'lucide-react';
import { useState } from 'react';

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
import '../board/board.css';
import '../../ui/ui.css';
import './productWorkspacePreview.css';

export type ProductPreviewView = 'terminal' | 'conversation' | 'board';

const TABS: Array<{ id: ProductPreviewView; label: string; detail: string }> = [
  { id: 'terminal', label: 'Terminal + files', detail: 'The live workspace' },
  { id: 'conversation', label: 'Conversation', detail: 'The same running thread' },
  { id: 'board', label: 'Task board', detail: 'What needs attention' },
];

export function ProductWorkspacePreview({ compact = false }: { compact?: boolean }) {
  const [view, setView] = useState<ProductPreviewView>('terminal');
  const returnToTerminal = () => {
    setView('terminal');
    window.requestAnimationFrame(() => document.getElementById('product-tab-terminal')?.focus());
  };

  return (
    <div className={`product-preview${compact ? ' product-preview--compact' : ''}`}>
      <div className="pub-product-tabs" role="tablist" aria-label="Real product views">
        {TABS.map((tab, index) => (
          <button
            key={tab.id}
            id={`product-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={view === tab.id}
            aria-controls="product-panel"
            tabIndex={view === tab.id ? 0 : -1}
            onClick={() => setView(tab.id)}
            onKeyDown={(event) => {
              if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return;
              event.preventDefault();
              const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
              const next = TABS[(index + delta + TABS.length) % TABS.length];
              setView(next.id);
              document.getElementById(`product-tab-${next.id}`)?.focus();
            }}
          >
            <span className="mono">0{index + 1}</span>
            <strong>{tab.label}</strong>
            <small>{tab.detail}</small>
          </button>
        ))}
      </div>

      <div
        id="product-panel"
        className="product-app"
        role="tabpanel"
        aria-labelledby={`product-tab-${view}`}
      >
        <ProductSidebar active={view} />
        <main className="product-detail">
          {view === 'terminal' && <TerminalAndFiles />}
          {view === 'conversation' && <Conversation onReturn={returnToTerminal} />}
          {view === 'board' && <Board />}
        </main>
      </div>
    </div>
  );
}

function ProductSidebar({ active }: { active: ProductPreviewView }) {
  const rows = [
    { icon: TerminalSquare, title: 'Release candidate', meta: 'workstation · working', selected: active === 'terminal', live: true },
    { icon: MessageSquare, title: 'Onboarding polish', meta: 'claude · 14m', selected: active === 'conversation' },
    { icon: MessageSquare, title: 'Security review', meta: 'claude · waiting', attention: true },
    { icon: TerminalSquare, title: 'Docs structure', meta: 'workstation · 1h', selected: false },
  ];
  return (
    <aside className="product-sidebar" aria-label="Example session sidebar" inert>
      <div className="sb">
        <header className="sb-header">
          <div className="sb-brand"><strong>Very Happy</strong></div>
          <div className="sb-header-right">
            <button className="sb-icon-btn" type="button" aria-label="Search"><Search size={16} /></button>
            <button className="sb-icon-btn" type="button" aria-label="Voice assistant"><AudioLines size={16} /></button>
            <button className="sb-icon-btn sb-board-btn" type="button" aria-label="Task board"><LayoutGrid size={16} /><span className="sb-board-badge mono">1</span></button>
            <button className="sb-icon-btn" type="button" aria-label="Collapse"><PanelLeftClose size={16} /></button>
            <button className="sb-icon-btn" type="button" aria-label="New session"><Plus size={17} /></button>
          </div>
        </header>
        <div className="sb-filter" role="presentation"><button className="sb-filter-btn is-on" type="button">LIST</button><button className="sb-filter-btn" type="button">STATUS</button><button className="sb-filter-btn" type="button">ARCHIVED</button></div>
        <div className="sb-list">
          <div className="sb-section">
            {rows.map(({ icon: Icon, title, meta, selected, attention, live }) => (
              <div key={title} className={`sb-row${selected ? ' is-selected' : ''}${attention ? ' sb-row--attention' : ''}`}>
                <button type="button" className="sb-row-main">
                  <span className={`sb-row-icon${Icon === TerminalSquare ? ' sb-row-icon--term' : ''}`}>{Icon === TerminalSquare && live ? <span className="sb-row-term-icon"><Icon size={16} /><span className="sb-row-agent-dot"><span className="vh-dot vh-dot--thinking vh-dot--pulse product-agent-dot" role="img" aria-label="Working" /></span></span> : <Icon size={16} />}</span>
                  <span className="sb-row-text"><span className="sb-row-title-line"><span className="sb-row-title">{title}</span></span><span className="sb-row-sub mono">{meta}</span></span>
                  {attention && <span className="sb-row-signal sb-row-signal--attention" />}
                </button>
                <button type="button" className="sb-row-menu" aria-label={`${title} actions`}><MoreHorizontal size={16} /></button>
              </div>
            ))}
          </div>
        </div>
        <footer className="sb-footer"><button className="sb-footer-btn" type="button"><Settings size={15} /> Settings</button></footer>
      </div>
    </aside>
  );
}

function TerminalAndFiles() {
  return (
    <><p className="sr-only">A live Codex terminal beside a project file browser and source preview, with the current session selected in the sidebar.</p><div className="term-screen" inert>
      <header className="term-header">
        <button className="vh-back" type="button" aria-label="Back"><ArrowLeft size={18} /></button>
        <button className="term-title" type="button"><span className="term-title-text">Release candidate</span><Pencil size={13} className="term-title-edit" /></button>
        <div className="term-header-right">
          <button className="sb-icon-btn" type="button" aria-label="Structured view"><MessagesSquare size={18} /></button>
          <button className="sb-icon-btn" type="button" aria-label="Notes"><StickyNote size={18} /></button>
          <button className="sb-icon-btn is-active" type="button" aria-label="Files"><FolderOpen size={18} /></button>
          <button className="sb-icon-btn" type="button" aria-label="Terminal help"><HelpCircle size={18} /></button>
        </div>
      </header>
      <div className="term-mid">
        <div className="term-host">
          <div className="term-host-inner product-xterm" aria-label="Sanitized Codex terminal">
            <div><span className="product-xterm-prompt">❯</span> verify the release candidate</div>
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
        <aside className="term-files product-term-files">
          <div className="term-files-head"><span className="term-files-title">Files</span><button type="button" className="sb-icon-btn" aria-label="Close files"><X size={16} /></button></div>
          <FilePreview />
        </aside>
      </div>
    </div></>
  );
}

function FilePreview() {
  return <div className="fsb-viewer product-file-preview"><div className="fsb-viewer-head"><span className="fsb-viewer-path">~/code/very-happy/src/screens/public/LandingScreen.tsx</span><button type="button" className="fsb-iconbtn" aria-label="Copy path"><Copy size={14} /></button><button type="button" className="fsb-iconbtn" aria-label="Fullscreen"><Maximize2 size={14} /></button><button type="button" className="fsb-iconbtn" aria-label="Back to files"><X size={15} /></button></div><div className="fsb-viewer-body"><div className="cv"><div className="cv-bar"><span className="cv-lang">tsx</span><span className="cv-copy mono">Copy</span></div><div className="cv-body"><pre className="cv-pre"><code>{`export function LandingScreen() {\n  return <ProductWorkspacePreview />;\n}`}</code></pre></div></div></div></div>;
}

function Conversation({ onReturn }: { onReturn: () => void }) {
  return <div className="sd"><div className="sd-main"><header className="ch" inert><button className="vh-back" type="button" aria-label="Back"><ArrowLeft size={18} /></button><div className="ch-main"><button type="button" className="ch-title-btn"><span className="ch-title">Onboarding polish</span><Pencil size={13} className="ch-title-pencil" /></button><div className="ch-crumb"><span className="ch-crumb-host">workstation</span><span className="ch-crumb-sep">·</span><span className="ch-crumb-cwd">~/code/very-happy</span></div></div><div className="ch-status"><button className="ch-icon" type="button" aria-label="Files"><FolderOpen size={17} /></button></div></header><div className="product-mirror-banner"><span className="mono">TERMINAL MIRROR · READ ONLY</span><button type="button" onClick={onReturn}>Return to terminal</button></div><div className="sd-body product-chat"><div className="msg msg--user"><div className="msg-bubble">Is this ready to show someone who has never used Very Happy?</div></div><div className="msg msg--agent"><div className="msg-agent-text">The core path is ready. I found one remaining issue: an input zooms on iOS. I’m applying the shared form rule and rerunning browser checks.</div></div><div className="product-tool-row mono"><Check size={13} /> edit · styles/base.css</div><div className="msg msg--agent"><div className="msg-agent-text">Fixed. The terminal stayed live, so you can switch back without losing the process.</div></div></div><div className="sd-foot"><div className="product-composer">Send a follow-up… <span className="mono">⌘↵</span></div></div></div></div>;
}

function Board() {
  const columns = [
    { title: 'WORKING', cards: [['Landing product proof', 'workstation', 'Reusing product UI contracts.']] },
    { title: 'WAITING ON ME', attention: true, cards: [['Approve production release', 'human judgment', 'All quality gates passed.']] },
    { title: 'DONE', cards: [['Security boundary review', 'review-node', 'Trusted relay language verified.']] },
  ];
  return <><p className="sr-only">A three-column task board showing work in progress, one release decision waiting for human judgment, and a completed security review.</p><div className="bd" inert><header className="bd-header"><button className="vh-back" type="button" aria-label="Back"><ArrowLeft size={18} /></button><span className="bd-title">Task board</span><span className="bd-summary-attn">1 needs you</span></header><div className="bd-cols">{columns.map((column) => <section key={column.title} className={`bd-col${column.attention ? ' bd-col--attention' : ''}`}><header className="bd-col-head"><span className="bd-col-label eyebrow">{column.title}</span><span className="bd-col-count mono">{column.cards.length}</span></header><div className="bd-col-list">{column.cards.map(([title, machine, progress]) => <div key={title} className={`bd-card bd-card--${column.attention ? 'attention' : column.title === 'WORKING' ? 'working' : 'idle'}`} role="button" tabIndex={0}><div className="bd-card-head"><span className={`product-status-dot${column.title === 'WORKING' ? ' is-live' : ''}${column.attention ? ' is-attention' : ''}`} /><span className="bd-card-title">{title}</span><button type="button" className="bd-card-done" aria-label="Mark done"><Check size={13} /></button><MessageSquare size={14} className="bd-card-kind" /></div><div className="bd-card-meta mono"><span className="bd-card-machine">{machine}</span><span className="bd-card-cwd">~/code/very-happy</span></div><div className="bd-card-progress">{progress}</div><div className="bd-card-foot mono"><span className="bd-card-time">2m ago</span></div></div>)}</div></section>)}</div></div></>;
}
