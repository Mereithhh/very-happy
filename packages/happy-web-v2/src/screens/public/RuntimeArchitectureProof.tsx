import { Bot, Braces, Cable, MonitorSmartphone, TerminalSquare, UploadCloud, Workflow } from 'lucide-react';
import { useReducer } from 'react';
import { usePublicI18n } from '@/i18n/publicI18n';
import {
  getRuntimeArchitectureRoute,
  INITIAL_RUNTIME_ARCHITECTURE_STATE,
  runtimeArchitectureReducer,
  type RuntimeArchitecturePath,
} from './runtimeArchitectureModel';
import './runtimeArchitectureProof.css';

type RuntimeCopy = {
  eyebrow: string;
  titleA: string;
  titleB: string;
  body: string;
  inspect: string;
  structured: string;
  terminal: string;
  source: string;
  bridge: string;
  surface: string;
  managedClaude: string;
  structuredDetail: string;
  eventAdapter: string;
  normalizedEvents: string;
  structuredUi: string;
  structuredUiDetail: string;
  tmuxProcess: string;
  tmuxDetail: string;
  controlMode: string;
  ptyStream: string;
  xterm: string;
  xtermDetail: string;
  commands: string;
  events: string;
  input: string;
  output: string;
  mirror: string;
  mirrorDetail: string;
  handoff: string;
  chunks: string;
  atomicFile: string;
  quotedPath: string;
  noAutoRun: string;
  liveRoute: string;
  workspace: string;
  truth: string;
};

const EN: RuntimeCopy = {
  eyebrow: 'TWO EXECUTION PATHS // ONE WORKSPACE',
  titleA: 'Understand the work.', titleB: 'Touch the real process.',
  body: 'Structured Claude sessions preserve agent semantics. The universal terminal path preserves the actual TTY. Very Happy keeps both in one workspace without pretending they are the same thing.',
  inspect: 'Inspect runtime path', structured: 'Structured agent', terminal: 'Real terminal',
  source: 'SOURCE OF TRUTH', bridge: 'MACHINE BRIDGE', surface: 'BROWSER SURFACE',
  managedClaude: 'Managed Claude process', structuredDetail: 'Claude Agent SDK contract',
  eventAdapter: 'Daemon event adapter', normalizedEvents: 'native event → shared envelope',
  structuredUi: 'Structured conversation', structuredUiDetail: 'messages · tools · diffs · usage',
  tmuxProcess: 'Real process inside tmux', tmuxDetail: 'agent CLI · shell · editor · SSH',
  controlMode: 'Daemon control mode', ptyStream: 'pane output ⇄ input bytes',
  xterm: 'xterm.js / actual TUI', xtermDetail: 'scrollback · search · reconnect',
  commands: 'SDK CALLS', events: 'NORMALIZED EVENTS', input: 'INPUT BYTES', output: 'PANE OUTPUT',
  mirror: 'OPTIONAL CLAUDE MIRROR', mirrorDetail: 'tmux ≥ 3.2 · installed hooks · Claude only',
  handoff: 'TERMINAL FILE HANDOFF', chunks: 'BOUNDED ENCRYPTED CHUNKS', atomicFile: 'ATOMIC TARGET FILE',
  quotedPath: 'QUOTED PATH AT CURSOR', noAutoRun: '≤ 8 MB · NO AUTO-RUN',
  liveRoute: 'LIVE ROUTE', workspace: 'ONE ACCOUNT WORKSPACE', truth: 'TWO SOURCES OF TRUTH',
};

const ZH: RuntimeCopy = {
  eyebrow: '两条执行路径 // 一个工作区',
  titleA: '看懂工作', titleB: '也能直接接管真实进程',
  body: '结构化 Claude 会话保留 Agent 语义；通用终端路径保留真实 TTY。Very Happy 把两者放进同一个工作区，但不会假装它们拥有相同能力。',
  inspect: '查看运行路径', structured: '结构化 Agent', terminal: '真实终端',
  source: '真实来源', bridge: '机器桥接', surface: '浏览器界面',
  managedClaude: '受管 Claude 进程', structuredDetail: 'Claude Agent SDK 契约',
  eventAdapter: 'Daemon 事件适配器', normalizedEvents: '原生事件 → 共享信封',
  structuredUi: '结构化对话', structuredUiDetail: '消息 · 工具 · Diff · 用量',
  tmuxProcess: 'tmux 中的真实进程', tmuxDetail: 'Agent CLI · Shell · 编辑器 · SSH',
  controlMode: 'Daemon control mode', ptyStream: 'Pane 输出 ⇄ 输入字节',
  xterm: 'xterm.js / 真实 TUI', xtermDetail: '回滚 · 搜索 · 重连',
  commands: 'SDK 调用', events: '归一化事件', input: '输入字节', output: 'PANE 输出',
  mirror: '可选 CLAUDE 镜像', mirrorDetail: 'tmux ≥ 3.2 · 已安装 Hooks · 仅 Claude',
  handoff: '终端文件交接', chunks: '有界加密分块', atomicFile: '原子写入目标文件',
  quotedPath: '光标处插入安全引用路径', noAutoRun: '≤ 8 MB · 不自动执行',
  liveRoute: '当前路径', workspace: '一个账号工作区', truth: '两种真实来源',
};

function RuntimeLane({
  path,
  activePath,
  c,
}: {
  path: RuntimeArchitecturePath;
  activePath: RuntimeArchitecturePath;
  c: RuntimeCopy;
}) {
  const structured = path === 'structured';
  const active = activePath === path;
  const SourceIcon = structured ? Bot : TerminalSquare;
  const BridgeIcon = structured ? Braces : Cable;
  const SurfaceIcon = structured ? Workflow : MonitorSmartphone;

  return <div className={`runtime-lane runtime-lane--${path}${active ? ' is-active' : ''}`} aria-label={structured ? c.structured : c.terminal}>
    <article className="runtime-node runtime-node--source">
      <span className="runtime-node-kicker mono">{c.source}</span>
      <SourceIcon size={21} aria-hidden="true" />
      <strong>{structured ? c.managedClaude : c.tmuxProcess}</strong>
      <small>{structured ? c.structuredDetail : c.tmuxDetail}</small>
    </article>
    <div className="runtime-link runtime-link--out" aria-hidden="true"><span className="mono">{structured ? c.commands : c.input}</span><i /><b /></div>
    <article className="runtime-node runtime-node--bridge">
      <span className="runtime-node-kicker mono">{c.bridge}</span>
      <BridgeIcon size={21} aria-hidden="true" />
      <strong>{structured ? c.eventAdapter : c.controlMode}</strong>
      <small className="mono">{structured ? c.normalizedEvents : c.ptyStream}</small>
    </article>
    <div className="runtime-link runtime-link--back" aria-hidden="true"><span className="mono">{structured ? c.events : c.output}</span><i /><b /></div>
    <article className="runtime-node runtime-node--surface">
      <span className="runtime-node-kicker mono">{c.surface}</span>
      <SurfaceIcon size={21} aria-hidden="true" />
      <strong>{structured ? c.structuredUi : c.xterm}</strong>
      <small>{structured ? c.structuredUiDetail : c.xtermDetail}</small>
    </article>
  </div>;
}

export function RuntimeArchitectureProof() {
  const { language } = usePublicI18n();
  const c = language === 'zh-Hans' ? ZH : EN;
  const [state, dispatch] = useReducer(runtimeArchitectureReducer, INITIAL_RUNTIME_ARCHITECTURE_STATE);
  const route = getRuntimeArchitectureRoute(state);

  return <section className="pub-runtime" aria-labelledby="runtime-title">
    <div className="pub-runtime-inner">
      <header className="pub-runtime-intro">
        <div><div className="eyebrow">{c.eyebrow}</div><h2 id="runtime-title">{c.titleA}<br /><span>{c.titleB}</span></h2></div>
        <div className="pub-runtime-copy"><p>{c.body}</p><div className="runtime-selector" role="group" aria-label={c.inspect}>
          {(['structured', 'terminal'] as const).map((path) => <button key={path} type="button" className={state.activePath === path ? 'is-active' : ''} aria-pressed={state.activePath === path} onClick={() => dispatch({ type: 'select-path', path })}>
            {path === 'structured' ? <Braces size={15} aria-hidden="true" /> : <TerminalSquare size={15} aria-hidden="true" />}
            <span>{path === 'structured' ? c.structured : c.terminal}</span>
          </button>)}
        </div></div>
      </header>

      <div className="runtime-console">
        <div className="runtime-console-head mono"><span><i /> RUNTIME FABRIC</span><span>{c.workspace} · {c.truth}</span></div>
        <div className={`runtime-stage is-${state.activePath}`}>
          <div className="runtime-stage-grid" aria-hidden="true" />
          <RuntimeLane path="structured" activePath={state.activePath} c={c} />
          <div className="runtime-mirror mono"><span>{c.mirror}</span><i /><strong>{c.mirrorDetail}</strong></div>
          <RuntimeLane path="terminal" activePath={state.activePath} c={c} />
        </div>
        <div className="runtime-handoff mono">
          <span><UploadCloud size={14} aria-hidden="true" /> {c.handoff}</span><i /><b>{c.chunks}</b><i /><b>{c.atomicFile}</b><i /><b>{c.quotedPath}</b><strong>{c.noAutoRun}</strong>
        </div>
        <div className="runtime-status mono" role="status" aria-live="polite"><span>{c.liveRoute}</span><strong>{route}</strong><b>{state.activePath === 'structured' ? c.structured : c.terminal}</b></div>
      </div>
    </div>
  </section>;
}
