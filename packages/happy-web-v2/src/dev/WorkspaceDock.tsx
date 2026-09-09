import { useState } from 'react';
import { FileText, Folder, Plus, X } from 'lucide-react';
import { WorkspaceTabs } from '@/screens/workspace/WorkspaceTabs';
import { Markdown } from '@/screens/session/Markdown';
export const dockKinds = ['文件浏览器', '快捷笔记', '全部笔记', '改动', '运行概览', '浏览器预览'];
const files=['src/screens/session/input.css','src/screens/sessions/Sidebar.tsx','docs/design-language.md'];
export function WorkspaceDock({ visible, tabs, active, onSelect, onOpen, onClose, onMove, onCloseOthers, onHide, note, setNote }: {visible:boolean;tabs:string[];active:string;onSelect:(s:string)=>void;onOpen:(s:string)=>void;onClose:(s:string)=>void;onMove:(id:string,target:string)=>void;onCloseOthers:(id:string)=>void;onHide:()=>void;note:string;setNote:(s:string)=>void}) {
 return <aside hidden={!visible} className="wd-dock" aria-label="工作区面板">
  <WorkspaceTabs tabs={tabs.map(tab=>({id:tab,title:tab.includes('/')?tab.split('/').pop()!:tab,description:tab}))} active={active} onSelect={onSelect} onClose={onClose} onMove={onMove} onCloseOthers={onCloseOthers} actions={<><button className="wd-icon" aria-label="添加工作区标签" onClick={()=>onOpen('面板入口')}><Plus size={16}/></button><button className="wd-icon" aria-label="收起工作区面板" onClick={onHide}><X size={16}/></button></>}/>
  {tabs.map((tab,i)=><section key={tab} id={`dock-panel-${i}`} role="tabpanel" aria-label={tab} hidden={active!==tab} className="wd-dock-body"><DockContent name={tab} onOpen={onOpen} note={note} setNote={setNote}/></section>)}
 </aside>;
}
function DockContent({name,onOpen,note,setNote}:{name:string;onOpen:(s:string)=>void;note:string;setNote:(s:string)=>void}) {
 const [url,setUrl]=useState('http://localhost:3000');
 if(name==='面板入口')return <><p className="wd-muted">在同一工作区打开多个标签</p>{dockKinds.map(kind=><button className="wd-option" key={kind} onClick={()=>onOpen(kind)}><Plus size={14}/>{kind}</button>)}</>;
 if(name==='文件浏览器')return <><p className="wd-muted">very-happy · 示例工作区</p><button className="wd-option" onClick={()=>onOpen('改动')}><Folder size={14}/>查看改动</button>{files.map(file=><button className="wd-option" key={file} onClick={()=>onOpen(file)}><FileText size={14}/><span>{file}</span></button>)}</>;
 if(name==='快捷笔记'||name==='全部笔记')return <><p className="wd-muted">本地草稿 · 切换或收起面板保留内容</p><textarea className="wd-note-editor" aria-label="工作区笔记" value={note} onChange={e=>setNote(e.target.value)} placeholder="随手记下下一步…"/></>;
 if(name==='改动')return <><p className="wd-muted">示例改动 · 不读取真实 Git 状态</p><pre className="wd-file-example">{'input.css\n− min-height: 76px;\n+ min-height: 50px;\n\nSidebar.tsx\n+ 统一新建入口\n+ 保留标签与排序'}</pre><button className="wd-option" onClick={()=>onOpen(files[0])}>打开 input.css</button></>;
 if(name==='运行概览')return <><p className="wd-muted">示例：跨会话与终端状态</p>{['待确认 · 终端权限','运行中 · 移动端验证','已完成 · 类型检查'].map(text=><div className="wd-option" key={text}>{text}</div>)}</>;
 if(name==='浏览器预览')return <><label className="wd-browser-address">预览地址<input aria-label="预览地址" value={url} onChange={e=>setUrl(e.target.value)}/></label><div className="wd-browser-sample"><h2>Very Happy</h2><p>应用预览区域</p><p className="wd-muted">本轮只展示浏览器标签的布局，不访问输入的网址。真实接入需要处理远端端口、嵌入限制和导航。</p></div></>;
 if(name.endsWith('.md'))return <><p className="wd-muted">{name} · 示例</p><Markdown text={'## Very Happy 设计标准\n\nLogo 保持原比例；文件、笔记与预览共享右侧标签区。\n\n- 桌面与对话并排。\n- 手机上切换为整屏。\n- 切换标签保留草稿和滚动位置。'}/></>;
 return <><p className="wd-muted">{name} · 示例文件</p><pre className="wd-file-example">{name.endsWith('.css')?'.composer {\n  background: var(--bg-1);\n  border-radius: 18px;\n  min-height: 50px;\n}':'export function Sidebar() {\n  // 项目、标签与不分组展示\n  return <WorkspaceNavigation />;\n}'}</pre></>;
}
