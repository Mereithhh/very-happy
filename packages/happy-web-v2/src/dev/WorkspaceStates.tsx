import { useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, Shield, WifiOff, Terminal, Code2, Sparkles, Monitor } from 'lucide-react';
import { CyberMark } from '@/ui/CyberMark';
const modes=['启动加载','页面加载','空会话','加载失败','连接恢复','权限等待'];
export function WorkspaceStates({onBack}:{onBack:()=>void}) {
 const [mode,setMode]=useState('启动加载'); const [retry,setRetry]=useState(false);
 useEffect(()=>{if(!retry)return;const id=window.setTimeout(()=>{setRetry(false);setMode('空会话');},1000);return()=>window.clearTimeout(id);},[retry]);
 return <div className="wd wd-state-page"><header className="wd-state-toolbar"><button className="wd-icon" aria-label="返回工作台" onClick={onBack}><ArrowLeft size={16}/></button><span>状态设计 · 本地示例</span><nav aria-label="状态示例">{modes.map(name=><button aria-pressed={mode===name} key={name} onClick={()=>{setRetry(false);setMode(name);}}>{name}</button>)}</nav></header>
 <main className="wd-state-stage">
 {(mode==='启动加载')?<div className="wd-boot" aria-busy="true"><div className="wd-boot-network" aria-hidden="true">
 <svg className="wd-boot-links" viewBox="0 0 280 216" fill="none"><path d="M140 44V84M62 108H116M164 108H218M140 132V174"/><path className="wd-boot-signal" d="M140 44V84M62 108H116M164 108H218M140 132V174"/></svg>
 <span className="wd-boot-node wd-boot-node--top"><Sparkles size={18}/><span>Claude Code</span></span>
 <span className="wd-boot-node wd-boot-node--left"><Code2 size={18}/><span>Codex</span></span>
 <span className="wd-boot-node wd-boot-node--right"><Terminal size={18}/><span>Terminal</span></span>
 <span className="wd-boot-node wd-boot-node--bottom"><Monitor size={18}/><span>你的工作空间</span></span>
 <span className="wd-boot-hub"><CyberMark size={42}/></span>
 </div><strong>Very Happy</strong><p role="status"><span className="wd-live-pulse"/>正在连接你的工作空间</p><small>机器、Agent、终端，在这里接续。</small><span className="wd-boot-example">连接示意 · 本地预览</span></div>
 :mode==='页面加载'||retry?<div className="wd-route-skeleton" aria-busy="true"><div className="wd-loading-caption" role="status"><span className="wd-live-pulse"/>正在加载会话</div><div aria-hidden="true" className="wd-skeleton-content"><div className="wd-skeleton-line wd-skeleton-short"/><div className="wd-skeleton-line"/><div className="wd-skeleton-line"/><div className="wd-skeleton-line wd-skeleton-medium"/></div><div className="wd-skeleton-input" aria-hidden="true"/></div>
 :mode==='空会话'?<div className="wd-state-message"><CyberMark size={28}/><h1>开始一项工作</h1><p>选择项目，或直接描述要完成的任务。</p><button className="wd-state-primary" onClick={onBack}>返回输入框</button></div>
 :mode==='加载失败'?<div className="wd-state-message"><RefreshCw size={24}/><h1>暂时无法加载会话</h1><p>已有内容和输入草稿会保留，可以重试。</p><button className="wd-state-primary" onClick={()=>setRetry(true)}>重试演示</button><button className="wd-option" onClick={onBack}>返回工作台</button></div>
 :mode==='连接恢复'?<div className="wd-route-skeleton"><div className="wd-connection-notice" role="status"><WifiOff size={15}/><span>连接已断开，正在尝试恢复</span><button onClick={()=>setRetry(true)}>重试</button></div><p className="wd-muted">已有对话继续展示，输入草稿保留；连接提醒不遮挡内容。</p><div aria-hidden="true" className="wd-skeleton-content"><div className="wd-skeleton-line"/><div className="wd-skeleton-line wd-skeleton-medium"/></div></div>
 :<div className="wd-state-message wd-permission-sample"><Shield size={24}/><h1>需要确认一次操作</h1><p>权限请求保留在会话中的明确位置，不藏进右侧工具标签。</p><code>pnpm test</code><p className="wd-muted">仅示例，不执行命令或更改权限。</p><div className="wd-permission-actions"><button className="wd-state-primary" onClick={onBack}>允许这一次（演示）</button><button onClick={onBack}>拒绝（演示）</button></div></div>}
 </main></div>;
}
