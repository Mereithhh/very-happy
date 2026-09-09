import { useId, useMemo, useState, type FormEvent } from 'react';
import {
  Check,
  Server,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import { usePublicI18n } from '../../i18n/publicI18n';

// These are the authenticated product's visual contracts. This public proof
// keeps only local demo state, so it never imports auth, sync, storage, or socket
// code into anonymous routes.
import '../sessions/newsession.css';
import './coreFeatureProofs.css';

type AgentKey = 'claude' | 'codex' | 'gemini' | 'openclaw' | 'pi';

const AGENTS: readonly AgentKey[] = ['claude', 'codex', 'gemini', 'openclaw', 'pi'];

const MACHINES = [
  { id: 'workstation', label: 'workstation', detail: 'online' },
  { id: 'build-server', label: 'build-server', detail: 'online' },
] as const;

const PATHS = ['~/code/very-happy', '~/code/site'] as const;

const AGENT_FACTS: Record<AgentKey, { status: string; detail: string }> = {
  claude: {
    status: 'DEEP SUPPORT',
    detail: 'Structured Claude conversation, terminal mirror, tools, diffs, and permissions.',
  },
  codex: {
    status: 'AVAILABLE NOW',
    detail: 'Starts a Codex process through the same daemon and responsive workspace.',
  },
  gemini: {
    status: 'ACP · BETA',
    detail: 'Uses the shipped Agent Client Protocol backend; a compatible Gemini ACP command is required.',
  },
  pi: {
    status: 'ACP RUNNER',
    detail: 'Starts pi through the managed pi-acp runner when it is available on the selected machine.',
  },
  openclaw: {
    status: 'GATEWAY ADAPTER',
    detail: 'Connects to a configured local OpenClaw gateway over its own protocol—not ACP.',
  },
};

function NewSessionProof({ titleId }: { titleId: string }) {
  const { language } = usePublicI18n();
  const zh = language === 'zh-Hans';
  const machineId = useId();
  const directoryId = useId();
  const instructionId = useId();
  const [machine, setMachine] = useState<(typeof MACHINES)[number]['id']>('workstation');
  const [directory, setDirectory] = useState<string>(PATHS[0]);
  const [agent, setAgent] = useState<AgentKey>('codex');
  const [instruction, setInstruction] = useState(zh ? '运行发布检查并汇总所有阻塞项。' : 'Run the release checks and summarize any blocker.');
  const [reviewed, setReviewed] = useState(false);

  const selectedMachine = useMemo(
    () => MACHINES.find((item) => item.id === machine) ?? MACHINES[0],
    [machine],
  );
  const agentFact = AGENT_FACTS[agent];

  const markChanged = () => setReviewed(false);

  const onReview = (event: FormEvent) => {
    event.preventDefault();
    if (!directory.trim()) return;
    setReviewed(true);
  };

  return (
    <article className="cfp-card cfp-card--launch" aria-labelledby={titleId}>
      <div className="cfp-copy">
        <div className="cfp-proof-line">
          <span>{zh ? '独立会话' : 'INDIVIDUAL SESSIONS'}</span>
          <span>{zh ? '明确的机器范围' : 'EXPLICIT MACHINE SCOPE'}</span>
        </div>
        <h3 id={titleId}>{zh ? '选好机器、路径和 Agent，然后开始' : 'Pick the machine, path, and agent. Then start.'}</h3>
        <p>
          {zh ? '也可以只开一个普通会话。Web 启动器支持 Claude、Codex、pi、Gemini 和 OpenClaw，实际可选项取决于机器配置。pi 通过托管 ACP runner 启动，Gemini 使用 beta ACP，OpenClaw 连接已配置的 gateway。' : 'Start an ordinary conversation whenever you prefer. The Web launcher supports Claude, Codex, pi, Gemini, and OpenClaw, depending on machine configuration. pi uses the managed ACP runner, Gemini uses beta ACP, and OpenClaw connects its configured gateway.'}
        </p>
      </div>

      <div className="cfp-surface" data-surface="launcher">
        <div className="cfp-surface-bar" aria-hidden="true">
          <span><i /> {zh ? '真实新建会话界面' : 'REAL NEW-SESSION UI'}</span>
          <span>{zh ? '脱敏演示 · 不会连接' : 'SANITIZED DEMO · NO CONNECTION'}</span>
        </div>

        <form className="ns-card cfp-launcher" onSubmit={onReview}>
          <div className="cfp-ui-kicker">{zh ? '当前 WEB 流程' : 'CURRENT WEB FLOW'}</div>
          <div className="ns-title">{zh ? '新建 Agent 会话' : 'New agent session'}</div>

          <label className="ns-label" htmlFor={machineId}>{zh ? '机器' : 'Machine'}</label>
          <select
            id={machineId}
            className="ns-select"
            value={machine}
            onChange={(event) => {
              setMachine(event.target.value as (typeof MACHINES)[number]['id']);
              markChanged();
            }}
          >
            {MACHINES.map((item) => (
              <option key={item.id} value={item.id}>{item.label} · {item.detail}</option>
            ))}
          </select>

          <label className="ns-label" htmlFor={directoryId}>{zh ? '目录' : 'Directory'}</label>
          <div className="ns-presets" aria-label={zh ? '示例目录预设' : 'Example directory presets'}>
            {PATHS.map((path) => (
              <button
                key={path}
                type="button"
                className={`ns-preset${directory === path ? ' is-on' : ''}`}
                aria-pressed={directory === path}
                onClick={() => {
                  setDirectory(path);
                  markChanged();
                }}
              >
                <span className="ns-preset-path">{path}</span>
              </button>
            ))}
          </div>
          <div className="ns-path-row">
            <input
              id={directoryId}
              className="ns-input"
              value={directory}
              placeholder="~/code/project"
              onChange={(event) => {
                setDirectory(event.target.value);
                markChanged();
              }}
            />
            <span className="ns-save is-saved" title="Path stays local to the selected machine" aria-hidden="true">
              <Check size={16} />
            </span>
          </div>

          <fieldset className="cfp-agent-fieldset">
            <legend className="ns-label">Agent</legend>
            <div className="ns-agents">
              {AGENTS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`ns-agent${agent === item ? ' is-on' : ''}`}
                  aria-pressed={agent === item}
                  onClick={() => {
                    setAgent(item);
                    markChanged();
                  }}
                >
                  {item}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="cfp-agent-fact" aria-live="polite" aria-atomic="true">
            <span>{agentFact.status}</span>
            <p>{agentFact.detail}</p>
          </div>

          <label className="ns-label" htmlFor={instructionId}>{zh ? '初始指令' : 'Initial instruction'}</label>
          <textarea
            id={instructionId}
            className="ns-input ns-initial"
            value={instruction}
            rows={2}
            onChange={(event) => {
              setInstruction(event.target.value);
              markChanged();
            }}
          />

          <div className="cfp-launch-summary">
            <Server size={14} aria-hidden="true" />
            <span><strong>{agent}</strong> {zh ? '位于' : 'on'} {selectedMachine.label}</span>
            <code>{directory || (zh ? '选择目录' : 'choose a directory')}</code>
          </div>

          <div className="ns-actions">
            <span className="cfp-demo-note">{zh ? '仅交互预览' : 'Interactive preview only'}</span>
            <button className="cfp-launch-button" type="submit" disabled={!directory.trim()}>
              <TerminalSquare size={15} />
              {zh ? '检查启动配置' : 'Review launch'}
            </button>
          </div>

          <div className="cfp-launch-result" data-visible={reviewed} aria-live="polite">
            {reviewed && <><Sparkles size={14} aria-hidden="true" /> {zh ? `选择已就绪。登录后的 App 会在 ${selectedMachine.label} 上创建该会话。` : `Selection ready. The signed-in app would create this session on ${selectedMachine.label}.`}</>}
          </div>
        </form>
      </div>
    </article>
  );
}

export function CoreFeatureProofs() {
  const { language } = usePublicI18n();
  const zh = language === 'zh-Hans';
  const instanceId = useId();
  const sectionTitleId = `${instanceId}-core-feature-proofs-title`;
  const launchTitleId = `${instanceId}-launch-proof-title`;
  return (
    <section id="proofs" className="cfp" aria-labelledby={sectionTitleId}>
      <header className="cfp-heading">
        <div>
          <div className="cfp-eyebrow">{zh ? '普通会话 // 照常使用' : 'ORDINARY CONVERSATIONS // ALWAYS AVAILABLE'}</div>
          <h2 id={sectionTitleId}>{zh ? '一个任务，一个 Agent，也很好' : 'One task. One agent. Your choice.'}</h2>
        </div>
        <p>
          {zh ? '团队是按需使用的能力。普通对话和终端仍可独立使用。试试下方启动器；这是本地演示，不会连接机器。' : 'Teams are optional. Ordinary conversations and terminals work independently. Try the launcher below; this local demo does not connect to a machine.'}
        </p>
      </header>

      <div className="cfp-grid">
        <NewSessionProof titleId={launchTitleId} />
      </div>
    </section>
  );
}
