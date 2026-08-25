import {
  Bot,
  Boxes,
  Braces,
  CloudCog,
  Command,
  Laptop,
  Mic2,
  Network,
  Server,
  Smartphone,
  TerminalSquare,
} from 'lucide-react';
import { useReducer } from 'react';
import { usePublicI18n } from '../../i18n/publicI18n';
import {
  getSchedulerRouteLabel,
  INITIAL_SCHEDULER_TOPOLOGY_STATE,
  SCHEDULER_LANE_DESCRIPTIONS,
  schedulerTopologyReducer,
} from './schedulerTopologyModel';
import './schedulerTopologyProof.css';

const ENVIRONMENTS = [
  { id: 'computer' as const, label: 'Your computer', detail: 'macOS / Linux', Icon: Laptop },
  { id: 'server' as const, label: 'Remote server', detail: 'cloud / homelab', Icon: Server },
  { id: 'runtime' as const, label: 'Any runtime', detail: 'VM / container', Icon: Boxes },
];

const AGENTS = [
  { id: 'claude' as const, label: 'Claude Code', detail: 'SDK + real TTY', Icon: Bot },
  { id: 'codex' as const, label: 'Codex', detail: 'native runner', Icon: Command },
  { id: 'gemini' as const, label: 'Gemini', detail: 'ACP beta', Icon: Braces },
  { id: 'terminal' as const, label: 'Any text TUI', detail: 'tmux terminal', Icon: TerminalSquare },
];

const LANES = [
  { id: 'cli' as const, label: 'CLI + daemon', detail: 'required bridge', Icon: CloudCog },
  { id: 'api' as const, label: 'API + webhooks', detail: 'server edge', Icon: Network },
  { id: 'meta' as const, label: 'Meta Agent', detail: 'Claude only', Icon: Mic2 },
  { id: 'mcp' as const, label: 'MCP tools', detail: 'runner-specific', Icon: Braces },
];

export function SchedulerTopologyProof() {
  const { language } = usePublicI18n();
  const zh = language === 'zh-Hans';
  const [state, dispatch] = useReducer(schedulerTopologyReducer, INITIAL_SCHEDULER_TOPOLOGY_STATE);
  const route = getSchedulerRouteLabel(state);
  const displayRoute = zh ? route
    .replace('Your computer', '你的电脑')
    .replace('Remote server', '远程服务器')
    .replace('Any runtime', '任意运行环境')
    .replace('Any text TUI', '任意文本 TUI') : route;
  const environments = zh ? [
    { ...ENVIRONMENTS[0], label: '你的电脑' }, { ...ENVIRONMENTS[1], label: '远程服务器', detail: '云端 / 家庭实验室' }, { ...ENVIRONMENTS[2], label: '任意运行环境', detail: '虚拟机 / 容器' },
  ] : ENVIRONMENTS;
  const agents = zh ? [
    { ...AGENTS[0], detail: 'SDK + 真实 TTY' }, { ...AGENTS[1], detail: '原生 runner' }, { ...AGENTS[2] }, { ...AGENTS[3], label: '任意文本 TUI', detail: 'tmux 终端' },
  ] : AGENTS;
  const lanes = zh ? [
    { ...LANES[0], detail: '必需桥接' }, { ...LANES[1], detail: '服务端边缘' }, { ...LANES[2], detail: '仅 Claude' }, { ...LANES[3], detail: '取决于 runner' },
  ] : LANES;
  const laneDescriptions = zh ? { cli: 'CLI 与 daemon 机器桥接', api: 'API 与 webhook 服务端入口', meta: 'Claude 协调助手', mcp: 'runner 对应的 MCP 工具' } : SCHEDULER_LANE_DESCRIPTIONS;

  return <div className="scheduler-proof" role="group" aria-label={zh ? '可交互的脱敏 Very Happy 调度架构' : 'Interactive sanitized Very Happy scheduler architecture'}>
    <div className="scheduler-proof-grid" aria-hidden="true" />
    <svg className="scheduler-wires" viewBox="0 0 700 500" preserveAspectRatio="none" aria-hidden="true">
      <path className={`scheduler-wire scheduler-wire--input${state.environment === 'computer' ? ' is-active' : ''}`} d="M92 67 C92 122 252 104 318 174" pathLength="1" />
      <path className={`scheduler-wire scheduler-wire--input${state.environment === 'server' ? ' is-active' : ''}`} d="M350 67 L350 165" pathLength="1" />
      <path className={`scheduler-wire scheduler-wire--input${state.environment === 'runtime' ? ' is-active' : ''}`} d="M608 67 C608 122 448 104 382 174" pathLength="1" />
      <path className={`scheduler-wire scheduler-wire--output${state.agent === 'claude' ? ' is-active' : ''}`} d="M316 330 C250 382 92 354 92 427" pathLength="1" />
      <path className={`scheduler-wire scheduler-wire--output${state.agent === 'codex' ? ' is-active' : ''}`} d="M338 335 C312 380 264 382 264 427" pathLength="1" />
      <path className={`scheduler-wire scheduler-wire--output${state.agent === 'gemini' ? ' is-active' : ''}`} d="M362 335 C388 380 436 382 436 427" pathLength="1" />
      <path className={`scheduler-wire scheduler-wire--output${state.agent === 'terminal' ? ' is-active' : ''}`} d="M384 330 C450 382 608 354 608 427" pathLength="1" />
    </svg>

    <div className="scheduler-zone-label scheduler-zone-label--machines mono">{zh ? '机器网络' : 'MACHINE FABRIC'}</div>
    <div className="scheduler-machines">
      {environments.map(({ id, label, detail, Icon }) => <button key={id} type="button" className={`scheduler-node scheduler-node--machine${state.environment === id ? ' is-active' : ''}`} aria-pressed={state.environment === id} onClick={() => dispatch({ type: 'select-environment', id })}>
        <Icon size={16} /><span><strong>{label}</strong><small className="mono">{detail}</small></span>
      </button>)}
    </div>

    <div className="scheduler-hub">
      <span className="scheduler-hub-ring scheduler-hub-ring--outer" aria-hidden="true" />
      <span className="scheduler-hub-ring scheduler-hub-ring--inner" aria-hidden="true" />
      <div className="scheduler-phone">
        <div className="scheduler-phone-top mono"><span><i /> VERY HAPPY</span><Smartphone size={13} /></div>
        <div className="scheduler-phone-body">
          <div className="scheduler-phone-kicker mono">{zh ? 'WEB / 手机控制' : 'WEB / PHONE CONTROL'}</div>
          <strong>{zh ? '一个控制面。' : 'One control plane.'}</strong>
          <div className="scheduler-stack mono" aria-label={zh ? 'Web 或 PWA 通过云端或自托管中继连接 CLI daemon' : 'Web or PWA through a Cloud or self-hosted relay and CLI daemon'}>
            <span className="sr-only">WEB / PWA → {zh ? '云端或自托管中继' : 'CLOUD OR SELF-HOSTED RELAY'} → CLI + DAEMON</span>
            <span>WEB</span><i>⇅</i><span>RELAY</span><i>⇅</i><span>DAEMON</span>
          </div>
          <div className="scheduler-route mono" title={displayRoute}><span>{displayRoute}</span></div>
          <div className="scheduler-dispatch mono"><i /> {zh ? '手动派发' : 'MANUAL DISPATCH'}</div>
        </div>
        <div className="scheduler-phone-nav mono"><span>{zh ? '会话' : 'SESSIONS'}</span><span>{zh ? '文件' : 'FILES'}</span><span>{zh ? '任务' : 'TASKS'}</span></div>
      </div>
    </div>

    <div className="scheduler-lanes" aria-label={zh ? '检视辅助控制界面' : 'Inspect supporting control surfaces'}>
      {lanes.map(({ id, label, detail, Icon }) => <button key={id} type="button" className={`scheduler-node scheduler-node--lane scheduler-node--${id}${state.inspectedLane === id ? ' is-inspected' : ''}`} aria-label={`${zh ? '检视' : 'Inspect'} ${laneDescriptions[id]}`} onClick={() => dispatch({ type: 'inspect-lane', id })}>
        <Icon size={14} /><span><strong>{label}</strong><small className="mono">{detail}</small></span>
      </button>)}
    </div>

    <div className="scheduler-zone-label scheduler-zone-label--agents mono">{zh ? 'AGENT + TUI 网络' : 'AGENT + TUI FABRIC'}</div>
    <div className="scheduler-agents">
      {agents.map(({ id, label, detail, Icon }) => <button key={id} type="button" className={`scheduler-node scheduler-node--agent${state.agent === id ? ' is-active' : ''}`} aria-pressed={state.agent === id} onClick={() => dispatch({ type: 'select-agent', id })}>
        <Icon size={15} /><span><strong>{label}</strong><small className="mono">{detail}</small></span>
      </button>)}
    </div>

    <div className="scheduler-proof-status mono" role="status" aria-live="polite">
      <span>{displayRoute}</span><span>{zh ? '检视' : 'INSPECT'}: {laneDescriptions[state.inspectedLane]}</span><strong>{zh ? '路径由你选择' : 'YOU CHOOSE THE ROUTE'}</strong>
    </div>
  </div>;
}
