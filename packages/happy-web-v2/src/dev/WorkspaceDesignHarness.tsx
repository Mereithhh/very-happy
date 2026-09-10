/** DEV-only design review. All content and actions are local examples; no session/network writes. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PanelRight, SlidersHorizontal, Tag, Play, ArrowDown, HelpCircle, ListChecks, ArrowUp, Check, ChevronDown, ChevronRight, CornerDownRight, FileText, Folder, Gauge, ListEnd, MoreHorizontal, PanelLeft, Plus, Search, Settings, Shield, Square, SquarePen, Sun, Moon, Terminal, Trash2, Users, X, Zap } from 'lucide-react';
import { WorkspaceStates } from './WorkspaceStates';
import { WorkspaceDock, dockKinds } from './WorkspaceDock';
import { WorkspaceReviewPanels, creationChoices } from './WorkspaceReviewPanels';
import { isAppChord } from '@/app/appChord';
import { RelayBadge } from '@/components/RelayBadge';
import { CyberMark } from '@/ui/CyberMark';
import { Markdown } from '@/screens/session/Markdown';
import './workspaceDesign.css';
import { WorkspaceDesignPages } from './WorkspaceDesignPages';

const projects = [
  { name: 'very-happy', tasks: ['统一会话界面与输入体验', '优化 UI 与终端体验', '支持 Codex backend 对话', '完善管理后台', '检查移动端会话恢复', '整理发布记录与回归清单'] },
  { name: 'skills', tasks: ['梳理工具与技能入口', '更新本地开发指南', '检查发布流程'] },
  { name: '个人项目', tasks: ['整理本周待办', '设计新的工作台'] },
];
const initial = '统一会话界面与输入体验';
const answer = '第一版会把侧边栏、对话和输入区统一成一套紧凑的工作界面。\n\n### 让信息更容易扫读\n\n- **侧边栏**：项目分组可折叠，会话标题保持一行；状态放在右侧，操作按需出现。\n- **对话区**：正文 14px，减少段落和工具调用之间的重复留白。\n- **输入区**：工具与发送保持同一排，用量直接放在下方。\n\n桌面优先展示更多内容，移动端保留完整的触摸区域。代码和长路径在自身容器内滚动。';

export function WorkspaceDesignHarness() {
  const [page, setPage] = useState('会话');
  const [theme, setTheme] = useState('light');
  const [sidebar, setSidebar] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [selected, setSelected] = useState(initial);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState(false);
  const [draft, setDraft] = useState('');
  const [running, setRunning] = useState(false);
  const [backend, setBackend] = useState('Claude Code');
  const [stream, setStream] = useState('');
  const [tick, setTick] = useState(0);
  const [away, setAway] = useState(false);
  const following = useRef(true);
  const content = useRef<HTMLDivElement>(null);
  const demo = Array.from({length: 14}, (_, i) => `### 检查 ${i + 1} · 会话体验\n\n这是一段本地模拟的流式输出，用来检查滚动跟随。正文逐步增加时，底部状态固定在原位，当前工具直接展示，不必展开才能知道进展。你可以向上滚动查看历史，再点击“回到最新”恢复跟随。\n\n`).join('');
  const startDemo = () => { following.current = true; setAway(false); setStream(''); setTick(0); setRunning(true); };
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      setTick(value => value + 1);
      setStream(value => demo.slice(0, value.length + 10));
    }, 90);
    return () => window.clearInterval(timer);
  }, [running, demo]);
  useEffect(() => { if (stream.length >= demo.length) setRunning(false); }, [stream.length, demo.length]);

  const [queue, setQueue] = useState<string[]>([]);
  const [messages, setMessages] = useState<string[]>([]);
  const [toolOpen, setToolOpen] = useState(false);
  const [panel, setPanel] = useState<string | null>(null);
  const [effort, setEffort] = useState('高');
  const [model, setModel] = useState('Claude Sonnet 4.6');
  const [permission, setPermission] = useState('自动执行');
  const [groupBy, setGroupBy] = useState('项目');
  const [order, setOrder] = useState(projects.flatMap(project => project.tasks));
  const [tags, setTags] = useState<Record<string,string>>({[initial]:'设计', '检查移动端会话恢复':'移动端'});
  const [tagDraft, setTagDraft] = useState('');
  const [dragging, setDragging] = useState<string|null>(null);
  const [dropTarget, setDropTarget] = useState<string|null>(null);
  const [updateSeen, setUpdateSeen] = useState(false);
  const moveTask = (title:string, target:string) => { if(title === target) return; setOrder(current => { const next=current.filter(item=>item!==title); next.splice(next.indexOf(target),0,title); return next; }); };
  const shownGroups = groupBy === '不分组' ? [{name:'全部会话',tasks:order}] : groupBy === '标签' ? Array.from(new Set(order.map(title=>tags[title]||'未加标签'))).map(name=>({name,tasks:order.filter(title=>(tags[title]||'未加标签')===name)})) : projects.map(project=>({...project,tasks:order.filter(title=>project.tasks.includes(title))}));
  const [dockTabs, setDockTabs] = useState<string[]>([]);
  const [activeDock, setActiveDock] = useState('');
  const [dockVisible, setDockVisible] = useState(false);
  const openDock = useCallback((name:string) => {setDockTabs(tabs=>tabs.includes(name)?tabs:[...tabs,name]);setActiveDock(name);setDockVisible(true);setPanel(null);setMobileNav(false);}, []);
  const closeDock = (name:string) => {const next=dockTabs.filter(tab=>tab!==name);setDockTabs(next);if(activeDock===name)setActiveDock(next[Math.max(0,dockTabs.indexOf(name)-1)]||'');if(!next.length)setDockVisible(false);};
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = theme;
    return () => { if (previous) document.documentElement.dataset.theme = previous; else delete document.documentElement.dataset.theme; };
  }, [theme]);
  useEffect(() => {
    if (input.current) { input.current.style.height = 'auto'; input.current.style.height = `${Math.min(160, input.current.scrollHeight)}px`; }
  }, [draft]);
  const followLatest = () => {
    if (following.current && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  };
  useLayoutEffect(followLatest, [messages, stream, page]);
  useEffect(() => {
    if (page !== '会话' || !content.current || !transcript.current) return;
    const observer = new ResizeObserver(followLatest);
    observer.observe(content.current);
    observer.observe(transcript.current);
    return () => observer.disconnect();
  }, [page]);
  useEffect(() => {
    if (!panel) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => previous?.focus();
  }, [panel]);
  const choose = (title: string) => { setSelected(title); setMessages([]); setQueue([]); setDraft(''); setStream(''); setTick(0); setRunning(false); setMobileNav(false); setPanel(null); };
  const submit = () => {
    if (!draft.trim()) { if (running) setRunning(false); return; }
    if (running) setQueue([...queue, draft.trim()]); else { setMessages([...messages, draft.trim()]); startDemo(); }
    setDraft('');
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing || !isAppChord(e) || e.altKey || e.shiftKey || page !== '会话') return;
      const next = e.code === 'KeyK' ? '命令中心' : e.code === 'KeyJ' ? '快捷笔记' : e.code === 'Period' ? '快捷指令' : null;
      if (!next) return;
      e.preventDefault(); e.stopPropagation(); if(next==='快捷笔记'){openDock(next);return;} setPanel(current => current === next ? null : next);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [page, openDock]);
  const openReview = (target: string) => {
    if(dockKinds.includes(target)){openDock(target);return;}
    if (['团队','待办','设置','帮助','界面状态'].includes(target)) { setPanel(null); setPage(target); }
    else setPanel(target);
  };
  if (page === '界面状态') return <WorkspaceStates onBack={()=>setPage('会话')}/>;
  if (page !== '会话') return <WorkspaceDesignPages page={page} onBack={() => setPage('会话')} onPage={setPage} theme={theme} onTheme={setTheme}/>;
  return (
    <div className={`wd ${sidebar ? '' : 'wd--collapsed'} ${mobileNav ? 'wd--nav-open' : ''} ${dockVisible ? 'wd--with-dock' : ''}`} onKeyDown={e => { if (e.key === 'Escape') { setMobileNav(false); setPanel(null); setSearch(false); } }}>
      {mobileNav && <button className="wd-scrim" aria-label="关闭侧边栏" onClick={() => setMobileNav(false)} />}
      <aside className="wd-sidebar" aria-label="工作区导航">
        <div className="wd-brand"><button className="wd-brand-home" aria-label="Very Happy 帮助" onClick={() => setPage('帮助')}><img src="/icon-192.png" width={28} height={28} alt=""/><strong>Very Happy</strong></button><button className="wd-icon" aria-label="收起侧边栏" onClick={() => { setSidebar(false); setMobileNav(false); }}><PanelLeft size={16} /></button></div>
        <nav className="wd-nav">
          <button onClick={() => setPanel('新建')}><SquarePen />新建<span className="wd-key">＋</span></button>
          <button onClick={() => setPanel('命令中心')}><Search />搜索与命令<span className="wd-key">⌘K</span></button>
          <button onClick={() => setPage('团队')}><Users />团队</button>
          <button onClick={() => setPage('待办')}><ListChecks />待办</button>
          <button onClick={() => setPage('帮助')}><HelpCircle />帮助</button>
        </nav>
        {search && <div className="wd-search"><Search size={14} /><input autoFocus aria-label="搜索会话" placeholder="搜索名称…" value={query} onChange={e => setQuery(e.target.value)} /><button aria-label="清除搜索" onClick={() => { setQuery(''); setSearch(false); }}><X size={14}/></button></div>}
        <div className="wd-projects"><div className="wd-section-label"><span>{groupBy === '不分组' ? '全部会话' : groupBy}</span><button className="wd-icon" aria-label="会话展示方式" onClick={() => setPanel('会话展示方式')}><SlidersHorizontal size={13}/></button></div>
          {shownGroups.map(project => <section key={project.name}>
            {groupBy !== '不分组' && <button className="wd-project" aria-expanded={!collapsed.includes(project.name)} onClick={() => setCollapsed(collapsed.includes(project.name) ? collapsed.filter(x => x !== project.name) : [...collapsed, project.name])}><Folder size={15} /><span>{project.name}</span>{collapsed.includes(project.name) ? <ChevronRight size={13} /> : <ChevronDown size={13}/>}</button>}
            {(groupBy === '不分组' || !collapsed.includes(project.name)) && project.tasks.filter(title => title.toLowerCase().includes(query.toLowerCase())).map((title, i) => <div key={title} draggable={groupBy === '不分组'} onDragStart={e=>{setDragging(title); e.dataTransfer.setData('text/plain',title); e.dataTransfer.effectAllowed='move';}} onDragOver={e=>{if(groupBy==='不分组' && dragging){e.preventDefault();setDropTarget(title);}}} onDrop={e=>{e.preventDefault();if(dragging)moveTask(dragging,title);setDragging(null);setDropTarget(null);}} onDragEnd={()=>{setDragging(null);setDropTarget(null);}} className={`wd-task ${selected === title ? 'is-selected' : ''} ${dropTarget === title ? 'wd-task--drop' : ''}`}><button className="wd-task-main" title={title} aria-current={selected === title ? 'page' : undefined} onClick={() => choose(title)}><span>{title}</span>{tags[title] && <small className="wd-tag">{tags[title]}</small>}{i === 0 ? <span className="wd-live-dot" title="运行中（示例）"/> : i === 2 ? <span className="wd-unread-dot" title="未读（示例）"/> : i === 4 ? <span className="wd-wait-dot" title="等待确认（示例）"/> : <span className="wd-task-age">{i + 1}h</span>}</button><button className="wd-task-more" aria-label={`${title}的操作`} onClick={() => { setSelected(title); setTagDraft(tags[title]||''); setPanel('会话操作'); }}><MoreHorizontal size={15}/></button></div>)}
          </section>)}
          {query && !projects.some(p => p.tasks.some(t => t.toLowerCase().includes(query.toLowerCase()))) && <p className="wd-muted">没有匹配的会话</p>}
        </div>
        <button className="wd-update-entry" onClick={() => setPanel('更新内容')}><span>{updateSeen ? '更新记录' : '有可查看的更新 · 示例'}</span><ChevronRight size={13}/></button><footer className="wd-sidebar-foot"><button onClick={() => setPage('设置')}><Settings size={16}/><span>工作区设置</span></button><button className="wd-icon" aria-label="快捷笔记" title="快捷笔记 ⌘J" onClick={() => openDock('快捷笔记')}><FileText size={16}/></button><button className="wd-icon" aria-label="切换主题" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={16}/> : <Sun size={16}/>}</button></footer>
      </aside>
      <main className="wd-main">
        <header className="wd-header"><button className="wd-icon wd-open-sidebar" aria-label="展开侧边栏" onClick={() => { setSidebar(true); setMobileNav(true); }}><PanelLeft size={17}/></button><span className="wd-header-mark" aria-label="Very Happy"><CyberMark size={18}/></span><strong>{selected}</strong><div className="wd-header-identity"><button className="wd-header-backend" title="驱动当前会话的 Agent" onClick={() => setPanel('驱动 Agent')}>{backend}</button><span className="wd-header-machine" title="机器：mac-office（示例）">mac-office</span></div><span className="wd-header-relay"><RelayBadge status={{transport:'regional',state:'connected',region:'Singapore',relayId:'preview-sg',rttMs:38}}/></span><span className="wd-preview-tag">示例</span><button className="wd-icon" aria-label="演示流式输出" title="演示流式输出" onClick={startDemo}><Play size={15}/></button><button className="wd-icon" aria-label="打开工作区面板" title="文件、笔记与预览" onClick={() => dockVisible ? setDockVisible(false) : dockTabs.length ? setDockVisible(true) : openDock('文件浏览器')}><PanelRight size={16}/></button><button className="wd-icon" aria-label="会话工具" title="文件、笔记与组建团队" onClick={() => setPanel('会话工具')}><MoreHorizontal size={16}/></button><button className="wd-icon" aria-label="查看设计标准" onClick={() => setPanel('设计标准')}><FileText size={16}/></button></header>
        <div className="wd-transcript" tabIndex={0} aria-label="会话记录" ref={transcript} onWheel={e => { if (e.deltaY < 0) { following.current = false; setAway(true); } }} onTouchMove={() => { following.current = false; setAway(true); }} onScroll={e => { const node = e.currentTarget; const near = node.scrollHeight - node.scrollTop - node.clientHeight < 32; following.current = near; setAway(!near); }}>
          <div className="wd-content" ref={content}>

            {selected !== '新对话' && <>
              <div className="wd-user">整体 UI 参考 Codex，更紧凑一些。先定设计标准，再做一个版本看看。</div>
              <div className="wd-assistant"><Markdown text="我会先统一字号、间距和信息层级，再把标准应用到完整的会话界面。侧边栏优先展示项目与任务，减少重复的说明和装饰。"/></div>
              <button className="wd-tools" aria-expanded={toolOpen} onClick={() => setToolOpen(!toolOpen)}>{toolOpen ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}<Check size={13}/><span>已查看 3 个文件</span><span className="wd-tool-files">Sidebar · Markdown · AgentInput</span><span className="wd-meta-right">12s</span></button>
              {toolOpen && <div className="wd-tool-detail">{['screens/sessions/Sidebar.tsx', 'screens/session/markdown.css', 'screens/session/AgentInput.tsx'].map(path => <div key={path}><FileText size={13}/><code>{path}</code><Check size={12}/></div>)}</div>}
              <div className="wd-assistant"><Markdown text={answer}/></div>
              <div className="wd-spec-grid"><div><span>界面文字</span><strong>14px</strong></div><div><span>对话正文</span><strong>14px</strong></div><div><span>会话行高</span><strong>32px</strong></div><div><span>触摸目标</span><strong>44px</strong></div></div>
              <div className="wd-assistant"><Markdown text={"这版保留现有实时状态的颜色语义。选中会话用中性底色，**运行、未读与等待处理**各自有明确标记，不依赖位置判断。\n\n可以折叠项目、搜索会话、切换主题，或者输入一条消息体验排队。所有操作都只在本地预览中生效。"}/></div>
              <div className="wd-answer-actions"><button aria-label="复制示例回复" onClick={() => { void navigator.clipboard.writeText(answer).then(() => setNotice('已复制示例回复'), () => setNotice('浏览器未允许复制')); }}><FileText size={13}/></button><button aria-label="引用示例回复" onClick={() => { setDraft('> 让信息更容易扫读\n\n'); input.current?.focus(); }}><CornerDownRight size={13}/></button><span>示例回复</span></div>
            </>}
            {selected === '新对话' && !messages.length && <div className="wd-empty"><SquarePen size={22}/><h1>开始一项工作</h1><p>输入任务，继续你的项目。</p></div>}
            {messages.map((message, i) => <div key={i} className="wd-user">{message}</div>)}
            {stream && <div className="wd-assistant wd-stream"><Markdown text={stream}/></div>}
          </div>
        </div>
        <div className="wd-compose-wrap"><div className="wd-compose-inner">
          <div className="wd-live-slot">
            {running ? <button className="wd-live-line" onClick={() => setPanel('实时进展')} aria-label="查看实时进展"><span className="wd-live-pulse" aria-hidden="true"/><span className="wd-live-label" role="status">{tick % 100 < 25 ? '正在思考' : tick % 100 < 65 ? 'Read · sidebar.css' : '正在输出'}</span><span className="wd-live-time">{Math.floor(tick * .09)}s</span><span className="wd-live-count">↑ 1.2k ↓ {Math.floor(stream.length / 2)}</span><ChevronRight size={12}/></button> : <span className="wd-live-idle">{stream ? '本地演示结束' : '本地预览 · 可点击右上角播放键体验持续输出'}</span>}
            {away && <button className="wd-follow" onClick={() => { following.current = true; setAway(false); followLatest(); }}><ArrowDown size={12}/>回到最新</button>}
          </div>
          <div className="wd-queue-list">{queue.map((text, i) => <div className="wd-queued" key={i}><ListEnd size={15}/><span title={text}>{text}</span><button title="调整方向" aria-label={`用排队消息 ${i + 1} 调整方向`} onClick={() => { setMessages([...messages, text]); setQueue(queue.filter((_, j) => i !== j)); }}><CornerDownRight size={15}/><span>调整方向</span></button><button aria-label={`删除排队消息 ${i + 1}`} onClick={() => setQueue(queue.filter((_, j) => i !== j))}><Trash2 size={14}/></button></div>)}</div>
          <div className="wd-composer"><textarea ref={input} aria-label="消息" placeholder="输入任务，或补充下一步…" value={draft} rows={2} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}/><div className="wd-toolbar"><button className="wd-icon" aria-label="添加或插入" onClick={() => setPanel(panel === '添加或插入' ? null : '添加或插入')}><Plus size={19}/></button><button className="wd-permission" onClick={() => setPanel('权限模式')} aria-label="权限模式"><Shield size={15}/><span>{permission}</span></button><div className="wd-toolbar-spacer"/><button className="wd-model" onClick={() => setPanel('模型与思考强度')}><Zap size={14}/><span>{model}</span><span className={`wd-effort ${effort === '最大' ? 'wd-effort--max' : ''}`}>{effort}</span><ChevronDown size={12}/></button><button className="wd-send" aria-label={draft.trim() ? running ? '排队发送' : '发送' : running ? '停止' : '发送'} disabled={!draft.trim() && !running} onClick={submit}>{running && !draft.trim() ? <Square size={14} fill="currentColor"/> : <ArrowUp size={19}/>}</button></div></div>
          <div className="wd-context"><Gauge size={12}/><span>上下文 36%</span><span>72k / 200k tokens</span><span className="wd-context-hint">{running ? '输入内容将排队' : 'Enter 发送 · Shift Enter 换行'}</span></div>
        </div></div>
      </main>
      {dockTabs.length > 0 && <WorkspaceDock visible={dockVisible} tabs={dockTabs} active={activeDock} onSelect={setActiveDock} onOpen={openDock} onClose={closeDock} onMove={(id,target)=>setDockTabs(tabs=>{const next=[...tabs];const from=next.indexOf(id),to=next.indexOf(target);if(from<0||to<0)return tabs;next.splice(to,0,next.splice(from,1)[0]);return next;})} onCloseOthers={id=>{setDockTabs([id]);setActiveDock(id);}} onHide={()=>setDockVisible(false)} note={note} setNote={setNote}/>}
      {panel && <div className="wd-dialog-backdrop" onClick={() => setPanel(null)}><section ref={dialog} onKeyDown={e => { if (e.key !== 'Tab') return; const nodes = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')); const first = nodes[0], last = nodes[nodes.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }} className="wd-dialog" role="dialog" aria-modal="true" aria-label={panel} onClick={e => e.stopPropagation()}><header><strong>{panel}</strong><button className="wd-icon" aria-label="关闭面板" onClick={() => setPanel(null)}><X size={17}/></button></header>
        {panel === '设计标准' ? <Markdown text={'### 紧凑工作台 · 第一版\n\n主要界面 14px / 正文 14px / 辅助 11–12px。桌面会话行高 32px，触屏点击区至少 44px。\n\n- 项目分组，标题单行，状态置右。\n- 对话正文行高 1.6，段落间距 12px。\n- 顶栏 44px，输入区与正文共用背景。\n- 中性色选中态，颜色用于有意义的状态。\n- 不堆叠卡片，不隐藏必要信息，不牺牲触摸区域。\n\n这是本地交互原型，示例消息不会发送给模型。'}/>
        : panel === '会话展示方式' ? <><p className="wd-muted">分组只影响浏览方式，不丢失会话。拖拽排序在“不分组”列表中启用。</p>{['项目','标签','不分组'].map(mode=><button className="wd-option" aria-pressed={groupBy===mode} key={mode} onClick={()=>{setGroupBy(mode);setPanel(null);}}>{mode}{groupBy===mode&&<Check size={14}/>}</button>)}</>
        : panel === '会话操作' ? <><p className="wd-muted">{selected}</p><label className="wd-tag-editor">标签<input aria-label="会话标签" value={tagDraft} onChange={e=>setTagDraft(e.target.value)} placeholder="例如：设计"/></label><button className="wd-option" onClick={()=>{setTags({...tags,[selected]:tagDraft.trim()});setPanel(null);}}><Tag size={14}/>保存标签</button><button className="wd-option" onClick={()=>{setGroupBy('不分组');setPanel(null);}}>在不分组列表中拖拽排序</button><button className="wd-option" onClick={()=>{const index=order.indexOf(selected);if(index>0)moveTask(selected,order[index-1]);setGroupBy('不分组');setPanel(null);}}>上移一位</button></>
        : panel === '更新内容' ? <><div className="wd-brand-home"><CyberMark size={30}/><strong>Very Happy · 工作台更新</strong></div><p className="wd-muted">设计示例，尚未发布</p><Markdown text={'### 更紧凑，也保留完整能力\n\n- 项目、标签和不分组展示，按你的方式组织会话。\n- 在不分组列表拖拽排序，手机可从菜单上移。\n- 统一新建入口，保留 tmux 接入与历史导入。\n- 固定实时状态、Agent 标识与快捷笔记。'}/><p className="wd-muted">正式版保留所有未读版本与 CLI 升级说明；关闭弹窗不等于已读，也不触发更新。</p><button className="wd-option" onClick={()=>{setUpdateSeen(true);setPanel(null);}}>我知道了</button><button className="wd-option" onClick={()=>setPanel('更新历史')}>查看更新历史<ChevronRight size={14}/></button></>
        : panel === '更新历史' ? <><p className="wd-muted">以下为原型条目，不代表版本发布。</p><button className="wd-option" onClick={()=>setPanel('更新内容')}>工作台体验更新 · 设计中<ChevronRight size={14}/></button><p className="wd-muted">生产接入复用现有完整更新记录页面。</p></>
        : panel === '会话工具' ? ['文件浏览器','改动','快捷笔记','浏览器预览','用这个对话组建团队','运行概览','快捷键','界面状态','设计标准'].map(action => <button className="wd-option" key={action} onClick={() => openReview(action)}>{action}<ChevronRight size={14}/></button>)
        : ['新建','命令中心','快捷笔记','全部笔记','文件浏览器','快捷键','运行概览','用这个对话组建团队','剪贴板历史',...creationChoices].includes(panel) ? <WorkspaceReviewPanels key={panel} panel={panel} open={openReview} newChat={() => { choose('新对话'); }} openSession={() => choose(initial)} note={note} setNote={setNote}/>
        : panel === '驱动 Agent' ? <><p className="wd-muted">驱动会话的程序，与底层模型是两项信息。此处切换仅供演示，正式界面读取会话 metadata。</p>{['Claude Code', 'Codex', 'Pi'].map(name => <button className="wd-option" key={name} onClick={() => { setBackend(name); setPanel(null); }}><Terminal size={14}/>{name}{backend === name && <Check size={14}/>}</button>)}</>
        : panel === '实时进展' ? <><p className="wd-muted">本地模拟 · 实时工具不必展开即可在底部看到</p><div className="wd-option"><Terminal size={14}/>{backend}</div><div className="wd-option">{tick % 100 < 25 ? '正在思考' : tick % 100 < 65 ? 'Read · sidebar.css' : '正在输出'}</div><div className="wd-option">输入 ↑ 1.2k · 输出 ↓ {Math.floor(stream.length / 2)}</div><div className="wd-option">缓存 72k · 思考 ≈ 2.4k（示例）</div><button className="wd-option" onClick={() => { setRunning(false); setPanel(null); }}>停止演示</button></>
        : panel === '添加或插入' ? ['添加附件', '快捷指令', '引用文件'].map(label => <button className="wd-option" key={label} onClick={() => { if (label === '快捷指令') setPanel('快捷指令'); else { setNotice(`${label}：第一版仅预览入口布局。`); setPanel(null); } }}><Plus size={15}/>{label}<ChevronRight size={14}/></button>)
        : panel === '快捷指令' ? ['检查本次改动，重点看边界和回归。', '先解释方案，再开始实现。', '运行测试并总结结果。'].map(text => <button className="wd-option" key={text} onClick={() => { setDraft(text); setPanel(null); input.current?.focus(); }}>{text}</button>)
        : panel === '权限模式' ? ['自动执行', '逐次确认', '只读'].map(mode => <button className="wd-option" key={mode} onClick={() => { setPermission(mode); setPanel(null); }}><Shield size={15}/>{mode}{permission === mode && <Check size={14}/>}</button>)
        : panel === '模型与思考强度' ? <><p className="wd-muted">模型（示例选项）</p>{['Claude Sonnet 4.6', 'GPT-5.5'].map(m => <button className="wd-option" key={m} onClick={() => setModel(m)}><Zap size={14}/>{m}{model === m && <Check size={14}/>}</button>)}<p className="wd-muted">思考强度</p><div className="wd-effort-options">{['低', '中', '高', '最大'].map(level => <button aria-pressed={effort === level} key={level} onClick={() => setEffort(level)}>{level}</button>)}</div><div className={`wd-effort-track ${effort === '最大' ? 'is-max' : ''}`}><span style={{width: `${(['低', '中', '高', '最大'].indexOf(effort) + 1) * 25}%`}}/></div></>
        : <><p className="wd-muted">这里展示「{panel}」的入口与面板样式。业务内容接入将在设计确认后完成。</p><button className="wd-option" onClick={() => setPanel(null)}>返回会话<ChevronRight size={14}/></button></>}
      </section></div>}
      {notice && <div className="wd-notice" role="status">{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}><X size={14}/></button></div>}
    </div>
  );
}
