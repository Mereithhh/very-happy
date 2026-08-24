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
  Workflow,
} from 'lucide-react';
import { useReducer } from 'react';
import {
  getSchedulerRouteLabel,
  INITIAL_SCHEDULER_TOPOLOGY_STATE,
  SCHEDULER_AGENT_LABELS,
  SCHEDULER_ENVIRONMENT_LABELS,
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
  { id: 'opencode' as const, label: 'OpenCode', detail: 'ACP beta', Icon: Braces },
  { id: 'terminal' as const, label: 'Any text TUI', detail: 'tmux terminal', Icon: TerminalSquare },
];

const LANES = [
  { id: 'cli' as const, label: 'CLI + daemon', detail: 'required bridge', Icon: CloudCog },
  { id: 'api' as const, label: 'API + webhooks', detail: 'server edge', Icon: Network },
  { id: 'meta' as const, label: 'Meta Agent', detail: 'Claude only', Icon: Mic2 },
  { id: 'mcp' as const, label: 'MCP tools', detail: 'runner-specific', Icon: Braces },
];

export function SchedulerTopologyProof() {
  const [state, dispatch] = useReducer(schedulerTopologyReducer, INITIAL_SCHEDULER_TOPOLOGY_STATE);
  const route = getSchedulerRouteLabel(state);

  return <div className="scheduler-proof" role="group" aria-label="Interactive sanitized Very Happy scheduler architecture">
    <div className="scheduler-proof-grid" aria-hidden="true" />
    <svg className="scheduler-wires" viewBox="0 0 700 500" preserveAspectRatio="none" aria-hidden="true">
      <path className={`scheduler-wire scheduler-wire--input${state.environment === 'computer' ? ' is-active' : ''}`} d="M92 67 C92 122 252 104 318 174" pathLength="1" />
      <path className={`scheduler-wire scheduler-wire--input${state.environment === 'server' ? ' is-active' : ''}`} d="M350 67 L350 165" pathLength="1" />
      <path className={`scheduler-wire scheduler-wire--input${state.environment === 'runtime' ? ' is-active' : ''}`} d="M608 67 C608 122 448 104 382 174" pathLength="1" />
      <path className="scheduler-wire scheduler-wire--side" d="M122 208 C184 208 206 226 242 236" pathLength="1" />
      <path className="scheduler-wire scheduler-wire--side" d="M578 208 C516 208 490 226 458 236" pathLength="1" />
      <path className="scheduler-wire scheduler-wire--side scheduler-wire--meta" d="M122 302 C144 344 110 369 92 427" pathLength="1" />
      <path className="scheduler-wire scheduler-wire--side" d="M578 302 C516 302 490 281 458 270" pathLength="1" />
      <path className={`scheduler-wire scheduler-wire--output${state.agent === 'claude' ? ' is-active' : ''}`} d="M316 330 C250 382 92 354 92 427" pathLength="1" />
      <path className={`scheduler-wire scheduler-wire--output${state.agent === 'codex' ? ' is-active' : ''}`} d="M338 335 C312 380 264 382 264 427" pathLength="1" />
      <path className={`scheduler-wire scheduler-wire--output${state.agent === 'opencode' ? ' is-active' : ''}`} d="M362 335 C388 380 436 382 436 427" pathLength="1" />
      <path className={`scheduler-wire scheduler-wire--output${state.agent === 'terminal' ? ' is-active' : ''}`} d="M384 330 C450 382 608 354 608 427" pathLength="1" />
    </svg>

    <div className="scheduler-zone-label scheduler-zone-label--machines mono">MACHINE FABRIC</div>
    <div className="scheduler-machines">
      {ENVIRONMENTS.map(({ id, label, detail, Icon }) => <button key={id} type="button" className={`scheduler-node scheduler-node--machine${state.environment === id ? ' is-active' : ''}`} aria-pressed={state.environment === id} onClick={() => dispatch({ type: 'select-environment', id })}>
        <Icon size={16} /><span><strong>{label}</strong><small className="mono">{detail}</small></span>
      </button>)}
    </div>

    {LANES.map(({ id, label, detail, Icon }) => <button key={id} type="button" className={`scheduler-node scheduler-node--lane scheduler-node--${id}`} aria-label={`Inspect ${SCHEDULER_LANE_DESCRIPTIONS[id]}`} onClick={() => dispatch({ type: 'inspect-lane', id })}>
      <Icon size={16} /><span><strong>{label}</strong><small className="mono">{detail}</small></span>
    </button>)}

    <div className="scheduler-hub">
      <span className="scheduler-hub-ring scheduler-hub-ring--outer" aria-hidden="true" />
      <span className="scheduler-hub-ring scheduler-hub-ring--inner" aria-hidden="true" />
      <div className="scheduler-phone">
        <div className="scheduler-phone-top mono"><span><i /> VERY HAPPY</span><Smartphone size={13} /></div>
        <div className="scheduler-phone-body">
          <div className="scheduler-phone-kicker mono">WEB / PHONE CONTROL</div>
          <strong>One control plane.</strong>
          <div className="scheduler-stack mono" aria-label="Web or PWA through trusted relay and CLI daemon">
            <span>WEB / PWA</span><i>⇅</i><span>TRUSTED RELAY</span><i>⇅</i><span>CLI + DAEMON</span>
          </div>
          <div className="scheduler-route mono"><span>{SCHEDULER_ENVIRONMENT_LABELS[state.environment]}</span><Workflow size={13} /><span>{SCHEDULER_AGENT_LABELS[state.agent]}</span></div>
          <div className="scheduler-dispatch mono"><i /> MANUAL DISPATCH</div>
        </div>
        <div className="scheduler-phone-nav mono"><span>SESSIONS</span><span>FILES</span><span>TASKS</span></div>
      </div>
    </div>

    <div className="scheduler-zone-label scheduler-zone-label--agents mono">AGENT + TUI FABRIC</div>
    <div className="scheduler-agents">
      {AGENTS.map(({ id, label, detail, Icon }) => <button key={id} type="button" className={`scheduler-node scheduler-node--agent${state.agent === id ? ' is-active' : ''}`} aria-pressed={state.agent === id} onClick={() => dispatch({ type: 'select-agent', id })}>
        <Icon size={15} /><span><strong>{label}</strong><small className="mono">{detail}</small></span>
      </button>)}
    </div>

    <div className="scheduler-proof-status mono" role="status" aria-live="polite">
      <span>{route}</span><span>INSPECT: {SCHEDULER_LANE_DESCRIPTIONS[state.inspectedLane]}</span><strong>YOU CHOOSE THE ROUTE</strong>
    </div>
  </div>;
}
