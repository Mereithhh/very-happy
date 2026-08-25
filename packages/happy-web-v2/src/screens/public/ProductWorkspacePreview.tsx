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
import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react';

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
import { usePublicI18n } from '../../i18n/publicI18n';
import './productWorkspacePreview.css';
import { getProductPreviewIds, type ProductPreviewView } from './productPreviewIds';
import { PUBLIC_COMMAND_PROOF_EVENT } from './publicContent';

const VIEW_LABELS: Record<ProductPreviewView, string> = {
  terminal: 'terminal and files',
  conversation: 'structured conversation',
  board: 'task board',
};

function previewSurfaceLabel(view: ProductPreviewView, workspaceNavOpen: boolean, zh: boolean): string {
  if (zh) return workspaceNavOpen ? '多机器会话指挥面板' : `${{ terminal: '终端与文件', conversation: '结构化对话', board: '任务看板' }[view]}产品预览`;
  return workspaceNavOpen ? 'multi-machine session command panel' : `${VIEW_LABELS[view]} product preview`;
}

export function ProductWorkspacePreview({
  compact = false,
  initialView,
  initialFilesOpen = true,
  initialWorkspaceNavOpen = false,
  sidebar = true,
  fileTransferDemo = false,
}: {
  compact?: boolean;
  initialView?: ProductPreviewView;
  initialFilesOpen?: boolean;
  initialWorkspaceNavOpen?: boolean;
  sidebar?: boolean;
  fileTransferDemo?: boolean;
}) {
  const { language } = usePublicI18n();
  const zh = language === 'zh-Hans';
  const [view, setView] = useState<ProductPreviewView>(initialView ?? (compact ? 'conversation' : 'terminal'));
  const [filesOpen, setFilesOpen] = useState(initialFilesOpen);
  const [workspaceNavOpen, setWorkspaceNavOpen] = useState(initialWorkspaceNavOpen);
  const surfaceLabel = previewSurfaceLabel(view, workspaceNavOpen, zh);
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
    focusInsideProduct(openFiles ? '.term-files-head button' : '.term-header-right button');
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
      <span className="sr-only" aria-live="polite">{zh ? `正在显示脱敏的${surfaceLabel}。` : `Showing the sanitized ${surfaceLabel}.`}</span>
      <div
        ref={productRef}
        id={ids.panel}
        className={`product-app${!sidebar ? ' product-app--no-sidebar' : ''}${workspaceNavOpen ? ' product-app--nav-open' : ''}`}
        role="group"
        aria-label={zh ? `可交互的脱敏${surfaceLabel}` : `Interactive sanitized ${surfaceLabel}`}
      >
        {sidebar && <ProductSidebar active={view} onSearch={() => window.dispatchEvent(new Event(PUBLIC_COMMAND_PROOF_EVENT))} onTerminal={() => showTerminal(false)} onBoard={openBoard} onCloseNav={closeWorkspaceNav} />}
        <div className="product-detail">
          {view === 'terminal' && <TerminalAndFiles filesId={ids.files} filesOpen={filesOpen} onBack={openWorkspaceNav} onCloseFiles={() => setFilesOpen(false)} onOpenFiles={() => setFilesOpen(true)} onStructured={openStructured} fileTransferDemo={fileTransferDemo} />}
          {view === 'conversation' && <Conversation onBack={openWorkspaceNav} onFiles={() => showTerminal(true)} onReturn={() => showTerminal(false)} />}
          {view === 'board' && <Board onBack={openWorkspaceNav} onOpenSession={(target) => target === 'terminal' ? showTerminal(false) : openStructured()} />}
        </div>
      </div>
    </div>
  );
}

function ProductSidebar({ active, onSearch, onTerminal, onBoard, onCloseNav }: { active: ProductPreviewView; onSearch: () => void; onTerminal: () => void; onBoard: () => void; onCloseNav: () => void }) {
  const { language } = usePublicI18n();
  const zh = language === 'zh-Hans';
  const rows = [
    { icon: TerminalSquare, title: zh ? '发布候选版' : 'Release candidate', actionable: true, meta: 'build · terminal', selected: active === 'terminal' || active === 'conversation', live: true },
    { icon: MessageSquare, title: zh ? '打磨新手流程' : 'Onboarding polish', meta: 'office · codex · ~/very-happy', selected: false },
    { icon: MessageSquare, title: zh ? '安全审查' : 'Security review', meta: 'stage · claude · ~/very-happy', attention: true },
    { icon: TerminalSquare, title: zh ? '文档结构' : 'Docs structure', meta: 'laptop · terminal', selected: false },
  ];
  return (
    <aside className="product-sidebar" aria-label={zh ? '多机器会话指挥面板示例' : 'Example multi-machine session command panel'}>
      <div className="sb">
        <header className="sb-header">
          <div className="sb-brand"><strong>Very Happy</strong></div>
          <div className="sb-header-right">
            <button className="sb-icon-btn" type="button" aria-label={zh ? '搜索操作、对话和终端' : 'Search actions, chats, and terminals'} onClick={onSearch}><Search size={16} /></button>
            <button className="sb-icon-btn" type="button" aria-label={zh ? '语音助手' : 'Voice assistant'} disabled><AudioLines size={16} /></button>
            <button className="sb-icon-btn sb-board-btn" type="button" aria-label={zh ? '打开任务看板' : 'Open task board'} aria-pressed={active === 'board'} onClick={onBoard}><LayoutGrid size={16} /><span className="sb-board-badge mono">1</span></button>
            <button className="sb-icon-btn product-nav-close" type="button" aria-label={zh ? '关闭会话列表' : 'Close session list'} onClick={onCloseNav}><PanelLeftClose size={16} /></button>
            <button className="sb-icon-btn" type="button" aria-label={zh ? '新建会话' : 'New session'} disabled><Plus size={17} /></button>
          </div>
        </header>
        <div className="sb-filter" role="presentation"><button className="sb-filter-btn is-on" type="button" disabled>{zh ? '列表' : 'LIST'}</button><button className="sb-filter-btn" type="button" disabled>{zh ? '状态' : 'STATUS'}</button><button className="sb-filter-btn" type="button" disabled>{zh ? '归档' : 'ARCHIVED'}</button></div>
        <div className="sb-list">
          <div className="sb-section">
            {rows.map(({ icon: Icon, title, meta, selected, attention, live, actionable }) => (
              <div key={title} className={`sb-row${selected ? ' is-selected' : ''}${attention ? ' sb-row--attention' : ''}`}>
                <button type="button" className="sb-row-main" data-product-session={actionable ? '' : undefined} disabled={!actionable} onClick={actionable ? onTerminal : undefined}>
                  <span className={`sb-row-icon${Icon === TerminalSquare ? ' sb-row-icon--term' : ''}`}>{Icon === TerminalSquare && live ? <span className="sb-row-term-icon"><Icon size={16} /><span className="sb-row-agent-dot"><span className="vh-dot vh-dot--thinking vh-dot--pulse product-agent-dot" role="img" aria-label={zh ? '工作中' : 'Working'} /></span></span> : <Icon size={16} />}</span>
                  <span className="sb-row-text"><span className="sb-row-title-line"><span className="sb-row-title">{title}</span></span><span className="sb-row-sub mono">{meta}</span></span>
                  {attention && <span className="sb-row-signal sb-row-signal--attention" />}
                </button>
                <button type="button" className="sb-row-menu" aria-label={zh ? `${title}操作` : `${title} actions`} disabled><MoreHorizontal size={16} /></button>
              </div>
            ))}
          </div>
        </div>
        <footer className="sb-footer"><button className="sb-footer-btn" type="button" disabled><Settings size={15} /> {zh ? '设置' : 'Settings'}</button></footer>
      </div>
    </aside>
  );
}

function TerminalAndFiles({ filesId, filesOpen, onBack, onCloseFiles, onOpenFiles, onStructured, fileTransferDemo }: { filesId: string; filesOpen: boolean; onBack: () => void; onCloseFiles: () => void; onOpenFiles: () => void; onStructured: () => void; fileTransferDemo: boolean }) {
  const { language } = usePublicI18n();
  const zh = language === 'zh-Hans';
  const filesButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const transferTimerRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [transfer, setTransfer] = useState<{ phase: 'uploading' | 'ready'; name: string; progress: number } | null>(null);
  useEffect(() => () => {
    if (transferTimerRef.current !== null) window.clearTimeout(transferTimerRef.current);
  }, []);
  const previewTransfer = (name = 'screenshot.png') => {
    if (!fileTransferDemo) return;
    if (transferTimerRef.current !== null) window.clearTimeout(transferTimerRef.current);
    setDragging(false);
    setTransfer({ phase: 'uploading', name, progress: 42 });
    transferTimerRef.current = window.setTimeout(() => {
      setTransfer({ phase: 'ready', name, progress: 100 });
      transferTimerRef.current = null;
    }, 1600);
  };
  const onTransferDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!fileTransferDemo) return;
    event.preventDefault();
    previewTransfer(event.dataTransfer.files[0]?.name || 'screenshot.png');
  };
  const onTransferPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!fileTransferDemo || event.clipboardData.files.length === 0) return;
    event.preventDefault();
    previewTransfer(event.clipboardData.files[0]?.name || 'screenshot.png');
  };
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
    <><p className="sr-only">{zh ? '持久终端中运行的 Claude 进程，旁边是项目文件浏览器和源码预览。' : 'A running Claude process in a durable terminal beside its project file browser and source preview.'}</p><div className="term-screen">
      <header className="term-header">
        <button className="vh-back" type="button" aria-label={zh ? '打开会话列表' : 'Open session list'} onClick={onBack}><ArrowLeft size={18} /></button>
        <button className="term-title" type="button" disabled><span className="term-title-text">{zh ? '发布候选版' : 'Release candidate'}</span><Pencil size={13} className="term-title-edit" /></button>
        <div className="term-header-right">
          <button className="sb-icon-btn" type="button" aria-label={zh ? '打开结构化 Claude 镜像' : 'Open structured Claude mirror'} onClick={onStructured}><MessagesSquare size={18} /></button>
          <button className="sb-icon-btn" type="button" aria-label={zh ? '备忘录' : 'Notes'} disabled><StickyNote size={18} /></button>
          <button ref={filesButtonRef} className={`sb-icon-btn${filesOpen ? ' is-active' : ''}`} type="button" aria-label={zh ? '打开文件' : 'Open files'} aria-controls={filesId} aria-expanded={filesOpen} onClick={openFiles}><FolderOpen size={18} /></button>
          <button className="sb-icon-btn" type="button" aria-label={zh ? '终端帮助' : 'Terminal help'} disabled><HelpCircle size={18} /></button>
        </div>
      </header>
      <div className="term-mid">
        <div
          className={`term-host${dragging ? ' is-dragover' : ''}`}
          tabIndex={fileTransferDemo ? 0 : undefined}
          aria-label={fileTransferDemo ? (zh ? '本地文件交接预览：在此粘贴或拖入文件' : 'Local file handoff preview: paste or drop a file here') : undefined}
          onDragOver={fileTransferDemo ? (event) => { event.preventDefault(); setDragging(true); } : undefined}
          onDragLeave={fileTransferDemo ? () => setDragging(false) : undefined}
          onDrop={onTransferDrop}
          onPaste={onTransferPaste}
        >
          {transfer?.phase === 'uploading' && <div className="term-upload-status mono" role="status" aria-live="polite"><span>{zh ? '正在上传' : 'Uploading'}… {transfer.name}</span><span>{transfer.progress}%</span><i style={{ '--term-upload-progress': `${transfer.progress}%` } as CSSProperties} /></div>}
          <div className="term-host-inner product-xterm" aria-label={zh ? '脱敏 Claude 终端' : 'Sanitized Claude terminal'}>
            <div><span className="product-xterm-prompt">❯</span> claude --resume release-candidate</div>
            <div className="product-xterm-gap" />
            <div>• {zh ? '正在审查新手与移动端流程…' : 'Auditing onboarding and mobile flows…'}</div>
            <div className="product-xterm-gap" />
            <div><span className="product-xterm-ok">✓</span> {zh ? '已修复 iOS 输入缩放' : 'fixed iOS input zoom'}</div>
            <div><span className="product-xterm-ok">✓</span> {zh ? '全量测试通过' : 'full test suite passed'}</div>
            <div><span className="product-xterm-ok">✓</span> {zh ? '生产 bundle 已构建' : 'production bundle built'}</div>
            <div className="product-xterm-gap" />
            <div>• {zh ? '正在审查' : 'Reviewing'} <span className="product-xterm-file">src/screens/public/</span></div>
            {transfer?.phase === 'ready' ? <><div className="product-xterm-dim">  {zh ? '已上传到选定机器 · 仅粘贴路径，未执行' : 'Uploaded to the selected machine · path pasted, not executed'}</div><div><span className="product-xterm-prompt">❯</span> '/Users/demo/.happy/uploads/terminal/drop-k9f-{transfer.name.replace(/[^\w.\-]+/g, '_')}' <span className="product-xterm-cursor">▋</span></div></> : <div className="product-xterm-dim">  {zh ? '正在打开' : 'Opening'} LandingScreen.tsx<span className="product-xterm-cursor">▋</span></div>}
          </div>
          {fileTransferDemo && <button type="button" className="product-transfer-trigger mono" onClick={() => previewTransfer()}>{transfer?.phase === 'ready' ? (zh ? '重播本地预览' : 'Replay local preview') : (zh ? '预览截图交接' : 'Preview screenshot handoff')}</button>}
        </div>
        {filesOpen && <aside id={filesId} className="term-files product-term-files" onKeyDown={keepOverlayFocus}>
          <div className="term-files-head"><span className="term-files-title">{zh ? '文件' : 'Files'}</span><button ref={closeButtonRef} type="button" className="sb-icon-btn" aria-label={zh ? '关闭文件并返回终端' : 'Close files and return to terminal'} onClick={closeFiles}><X size={16} /></button></div>
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

Cloud keeps multi-device access seamless;
self-host when operator control matters.`,
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
  const { language } = usePublicI18n();
  const zh = language === 'zh-Hans';
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
        <nav className="fsb-crumbs mono" aria-label={zh ? '示例文件面包屑' : 'Example file breadcrumbs'}>
          <span className="fsb-crumb-seg">
            <span className="fsb-crumb">~</span><span className="fsb-crumb-sep">/</span>
            <span className="fsb-crumb">very-happy</span><span className="fsb-crumb-sep">/</span>
            <span className="fsb-crumb is-current" aria-current="location">public</span>
          </span>
        </nav>
        <span inert><button type="button" className="fsb-iconbtn" aria-label={zh ? '按时间排序' : 'Sort by time'}><Clock size={14} /></button><button type="button" className="fsb-iconbtn" aria-label={zh ? '显示隐藏文件' : 'Show hidden files'}><EyeOff size={14} /></button><button type="button" className="fsb-iconbtn" aria-label={zh ? '刷新' : 'Refresh'}><RefreshCw size={14} /></button></span>
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
  const { language } = usePublicI18n();
  const zh = language === 'zh-Hans';
  return <div className="fsb-viewer product-file-preview"><div className="fsb-viewer-head"><span className="fsb-viewer-path">~/code/very-happy/src/screens/public/{file}</span><span inert><button type="button" className="fsb-iconbtn" aria-label={zh ? '复制路径' : 'Copy path'}><Copy size={14} /></button><button type="button" className="fsb-iconbtn" aria-label={zh ? '全屏' : 'Fullscreen'}><Maximize2 size={14} /></button></span><button ref={backButtonRef} type="button" className="fsb-iconbtn" aria-label={zh ? '返回文件列表' : 'Back to file list'} onClick={onBack}><ArrowLeft size={15} /></button></div><div className="fsb-viewer-body"><div className="cv"><div className="cv-bar"><span className="cv-lang">{file.split('.').pop()}</span><span className="cv-copy mono">{zh ? '已脱敏' : 'SANITIZED'}</span></div><div className="cv-body"><pre className="cv-pre"><code>{PREVIEW_FILE_CONTENT[file]}</code></pre></div></div></div></div>;
}

function Conversation({ onBack, onFiles, onReturn }: { onBack: () => void; onFiles: () => void; onReturn: () => void }) {
  const { language } = usePublicI18n();
  const zh = language === 'zh-Hans';
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
  const inputLabel = zh ? '向本地预览添加消息；不会发送' : 'Add a message to the local preview; nothing is sent';
  return <div className="sd"><div className="sd-main"><header className="ch"><button className="vh-back" type="button" aria-label={zh ? '打开会话列表' : 'Open session list'} onClick={onBack}><ArrowLeft size={18} /></button><div className="ch-main"><button type="button" className="ch-title-btn" disabled><span className="ch-title">{zh ? '发布候选版' : 'Release candidate'}</span><Pencil size={13} className="ch-title-pencil" /></button><div className="ch-crumb"><span className="ch-crumb-host">workstation</span><span className="ch-crumb-sep">·</span><span className="ch-crumb-cwd">~/code/very-happy</span></div></div><div className="ch-status"><button className="ch-icon" type="button" aria-label={zh ? '打开文件' : 'Open files'} onClick={onFiles}><FolderOpen size={17} /></button></div></header><div className="mrb"><div className="mrb-note" role="note"><span className="mrb-note-text">{zh ? '已安装可选终端 hooks · 演示输入仅留在本地' : 'Optional terminal hooks installed · demo input stays local'}</span><span className="mrb-meter mono">38k · {zh ? '剩余 81%' : '81% left'}</span><button type="button" className="mrb-term-btn mono" onClick={onReturn}><TerminalSquare size={13} /><span>{zh ? '返回终端' : 'Back to terminal'}</span></button></div></div><div className="sd-body product-chat"><div className="msg msg--user"><div className="msg-bubble">{zh ? '发布检查继续运行时，我可以离开终端吗？' : 'Can I leave the terminal while the release check keeps running?'}</div></div><div className="msg msg--agent"><div className="msg-agent-text">{zh ? '可以。这个结构化视图会跟随当前 Claude 终端绑定，包括工具活动和结果。' : 'Yes. This structured view follows the active Claude terminal binding, including tool activity and results.'}</div></div><ToolActivityProof /><div className="msg msg--agent"><div className="msg-agent-text">{zh ? '进程仍在运行。原始 TUI 需要你处理时，使用“返回终端”。' : 'The process is still live. Use “Back to terminal” when the raw TUI needs your attention.'}</div></div>{sent && <div className="msg msg--user"><div className="msg-bubble">{sent}</div></div>}</div><div className="mri"><span id={demoNoteId} className="sr-only">{zh ? '公开页本地预览。该文本不会发送或存储。' : 'Local public-page preview. This text is not sent or stored.'}</span><textarea className="mri-input" rows={1} value={draft} placeholder={zh ? '本地预览 · 不会发送' : 'LOCAL PREVIEW · NOT SENT'} aria-label={inputLabel} aria-describedby={demoNoteId} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !ime.isGuarded(event)) { event.preventDefault(); send(); } }} onCompositionStart={ime.onCompositionStart} onCompositionEnd={ime.onCompositionEnd} /><button type="button" className="mri-send" aria-label={inputLabel} disabled={!draft.trim()} onClick={() => { if (!ime.isComposing()) send(); }}><SendHorizontal size={16} /></button></div></div></div>;
}

function ToolActivityProof() {
  const { language } = usePublicI18n();
  const zh = language === 'zh-Hans';
  const [open, setOpen] = useState(false);
  return <div className="tg tg--done"><div className="tg-spine" aria-hidden="true" /><div className="tg-content"><div className="tg-row"><div className="tg-row-head-wrap"><button type="button" className="tg-row-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}><ChevronRight size={13} className={`tg-chevron${open ? ' is-open' : ''}`} /><span className="vh-dot vh-dot--connected" aria-hidden="true" /><span className="tg-tool-label">{zh ? '编辑' : 'Edit'}</span></button><span className="tg-tool-detail">styles/base.css</span></div>{open && <div className="tg-body"><div className="cv product-diff"><div className="cv-bar"><span className="cv-lang">diff</span><span className="cv-copy mono">{zh ? '已脱敏' : 'SANITIZED'}</span></div><div className="cv-body"><pre className="cv-pre"><code>{'- font-size: var(--fs-14);\n+ font-size: var(--fs-16);'}</code></pre></div></div></div>}</div></div></div>;
}

function Board({ onBack, onOpenSession }: { onBack: () => void; onOpenSession: (target: 'terminal' | 'conversation') => void }) {
  const { language } = usePublicI18n();
  const zh = language === 'zh-Hans';
  const [completed, setCompleted] = useState<string[]>([]);
  const columns = [
    { key: 'working', title: zh ? '进行中' : 'WORKING', cards: [[zh ? '首页产品证明' : 'Landing product proof', 'workstation', zh ? '正在复用产品 UI 契约。' : 'Reusing product UI contracts.']] },
    { key: 'waiting', title: zh ? '等待我处理' : 'WAITING ON ME', attention: true, cards: [[zh ? '批准生产发布' : 'Approve production release', zh ? '人工判断' : 'human judgment', zh ? '所有质量门禁均已通过。' : 'All quality gates passed.']] },
    { key: 'done', title: zh ? '已完成' : 'DONE', cards: [[zh ? '部署审查' : 'Deployment review', 'review-node', zh ? '已验证云端与自托管选项。' : 'Cloud and self-host choices verified.']] },
  ];
  const openCard = (column: string) => onOpenSession(column === 'working' ? 'terminal' : 'conversation');
  return <><p className="sr-only">{zh ? '三列任务看板：进行中的工作、一项等待人工判断的发布决策，以及已完成的安全审查。' : 'A three-column task board showing work in progress, one release decision waiting for human judgment, and a completed security review.'}</p><div className="bd"><header className="bd-header"><button className="vh-back" type="button" aria-label={zh ? '打开会话列表' : 'Open session list'} onClick={onBack}><ArrowLeft size={18} /></button><span className="bd-title">{zh ? '任务看板' : 'Task board'}</span><span className="bd-summary-attn">{zh ? '1 项需你处理' : '1 needs you'}</span></header><div className="bd-cols">{columns.map((column) => <section key={column.key} className={`bd-col${column.attention ? ' bd-col--attention' : ''}`}><header className="bd-col-head"><span className="bd-col-label eyebrow">{column.title}</span><span className="bd-col-count mono">{column.cards.length}</span></header><div className="bd-col-list">{column.cards.map(([title, machine, progress]) => { const isDone = completed.includes(title); return <div key={title} className={`bd-card bd-card--${column.attention ? 'attention' : column.key === 'working' ? 'working' : 'idle'}${isDone ? ' bd-card--ended' : ''}`} role="button" tabIndex={0} aria-label={zh ? `打开${title}` : `Open ${title}`} onClick={() => openCard(column.key)} onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openCard(column.key); } }}><div className="bd-card-head"><span className={`product-status-dot${column.key === 'working' && !isDone ? ' is-live' : ''}${column.attention && !isDone ? ' is-attention' : ''}`} /><span className="bd-card-title">{title}</span><button type="button" className="bd-card-done" aria-label={isDone ? (zh ? `${title}已标记完成` : `${title} marked done`) : (zh ? `标记${title}完成` : `Mark ${title} done`)} aria-pressed={isDone} onClick={(event) => { event.stopPropagation(); setCompleted((items) => items.includes(title) ? items.filter((item) => item !== title) : [...items, title]); }}><Check size={13} /></button><MessageSquare size={14} className="bd-card-kind" /></div><div className="bd-card-meta mono"><span className="bd-card-machine">{machine}</span><span className="bd-card-cwd">~/code/very-happy</span></div><div className="bd-card-progress">{isDone ? (zh ? '已在本地演示中标记完成。' : 'Marked done in this local demo.') : progress}</div><div className="bd-card-foot mono"><span className="bd-card-time">{zh ? '2 分钟前' : '2m ago'}</span></div></div>; })}</div></section>)}</div></div></>;
}
