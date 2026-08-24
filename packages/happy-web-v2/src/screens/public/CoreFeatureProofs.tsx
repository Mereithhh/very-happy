import { useEffect, useId, useMemo, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import {
  Check,
  Mic,
  Rocket,
  SendHorizontal,
  Server,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import { AssistantLogo, type AssistantLogoState } from '../assistant/AssistantLogo';
import { CyberMark } from '../../ui/CyberMark';

// These are the authenticated product's visual contracts. This public proof
// keeps only local demo state, so it never imports auth, sync, storage, or socket
// code into anonymous routes.
import '../assistant/assistant.css';
import '../sessions/newsession.css';
import './coreFeatureProofs.css';

type AgentKey = 'claude' | 'codex' | 'gemini' | 'openclaw';
type VoicePreviewState = Extract<AssistantLogoState, 'idle' | 'listening' | 'speaking'>;

const AGENTS: readonly AgentKey[] = ['claude', 'codex', 'gemini', 'openclaw'];

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
  openclaw: {
    status: 'GATEWAY ADAPTER',
    detail: 'Connects to a configured local OpenClaw gateway over its own protocol—not ACP.',
  },
};

function VoiceCoordinatorProof({ titleId }: { titleId: string }) {
  const inputId = useId();
  const [voiceState, setVoiceState] = useState<VoicePreviewState>('idle');
  const [speakingTurn, setSpeakingTurn] = useState(0);
  const [draft, setDraft] = useState('What still blocks the release?');
  const [userText, setUserText] = useState('Check the release without making me patrol every session.');
  const [reply, setReply] = useState('Two checks remain on workstation: the mobile browser pass and the final security review. I will keep the summary here.');

  useEffect(() => {
    if (voiceState !== 'speaking') return;
    const timer = window.setTimeout(() => setVoiceState('idle'), 2200);
    return () => window.clearTimeout(timer);
  }, [speakingTurn, voiceState]);

  const finishVoicePreview = () => {
    setVoiceState('speaking');
    setSpeakingTurn((turn) => turn + 1);
    setUserText('Give me the release status.');
    setReply('The selected workstation is healthy. One browser check remains; no other machine was contacted.');
  };

  const onPttDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setVoiceState('listening');
  };

  const onPttUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishVoicePreview();
  };

  const onPttKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
      event.preventDefault();
      setVoiceState('listening');
    }
  };

  const onPttKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      finishVoicePreview();
    }
  };

  const submitText = (event: FormEvent) => {
    event.preventDefault();
    const next = draft.trim();
    if (!next) return;
    setUserText(next);
    setReply('I can coordinate Claude work on workstation and report back here. Fleet-wide provider routing is still roadmap.');
    setDraft('');
    setVoiceState('speaking');
    setSpeakingTurn((turn) => turn + 1);
  };

  const stateLabel = voiceState === 'listening'
    ? 'LISTENING · PREVIEW ONLY'
    : voiceState === 'speaking'
      ? 'SAMPLE REPLY'
      : 'READY ON SELECTED MACHINE';

  return (
    <article className="cfp-card cfp-card--voice" aria-labelledby={titleId}>
      <div className="cfp-copy">
        <div className="cfp-proof-line">
          <span>OPTIONAL VOICE</span>
          <span>REQUIRES VOICE CONFIGURATION</span>
        </div>
        <h3 id={titleId}>Talk to the work, on the machine you chose.</h3>
        <p>
          The coordinator is a Claude meta-agent session on one selected machine. Hold to talk or type;
          configured speech services add STT/TTS. Automatic cross-machine or cross-provider routing is roadmap.
        </p>
      </div>

      <div className="cfp-surface" data-surface="voice">
        <div className="cfp-surface-bar" aria-hidden="true">
          <span><i /> REAL ASSISTANT UI</span>
          <span>LOCAL INTERACTION · NO AUDIO CAPTURE</span>
        </div>
        <div
          className="as-root cfp-voice"
          style={{ '--as-level': voiceState === 'listening' ? 0.72 : 0 } as CSSProperties}
        >
          <div className="as-col">
            <header className="as-header">
              <span className="as-header-title">Meta-agent</span>
              <span className="as-header-machine">workstation · selected</span>
              <span className="as-header-spacer" />
              <span className="cfp-config-chip">VOICE OPTIONAL</span>
            </header>

            <div className="as-stage">
              <AssistantLogo
                state={voiceState}
                size={116}
                glyph={<CyberMark size={38} />}
              />
              <div
                className="as-state-label"
                data-live={voiceState === 'listening' || voiceState === 'speaking'}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {stateLabel}
              </div>

              <div className="as-convo" aria-live="polite">
                <div className="as-convo-user" data-live={voiceState === 'listening'}>{userText}</div>
                <div className="as-convo-assistant">{reply}</div>
              </div>

              <div className="as-ticker" data-running="false">
                <Rocket size={13} className="as-ticker-icon" aria-hidden="true" />
                <span className="as-ticker-name">Claude dispatch scope</span>
                <span className="as-ticker-arg">workstation only</span>
              </div>
            </div>

            <div className="as-controls">
              <button
                type="button"
                className="as-ptt"
                data-recording={voiceState === 'listening'}
                aria-pressed={voiceState === 'listening'}
                aria-label="Hold to talk in the local preview; no audio is recorded"
                onPointerDown={onPttDown}
                onPointerUp={onPttUp}
                onPointerCancel={() => setVoiceState('idle')}
                onKeyDown={onPttKeyDown}
                onKeyUp={onPttKeyUp}
                onClick={() => { if (voiceState === 'idle') finishVoicePreview(); }}
                onContextMenu={(event) => event.preventDefault()}
              >
                {voiceState === 'listening' ? (
                  <span className="as-ptt-level" aria-hidden="true">
                    <span /><span /><span /><span /><span />
                  </span>
                ) : <Mic size={28} />}
              </button>
              <span className="as-ptt-hint">Hold to preview · microphone is not opened</span>

              <form className="as-input-row" onSubmit={submitText}>
                <label className="sr-only" htmlFor={inputId}>Message the coordinator preview</label>
                <input
                  id={inputId}
                  className="as-input"
                  type="text"
                  value={draft}
                  placeholder="Ask the selected-machine coordinator"
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button
                  type="submit"
                  className="as-send-btn"
                  aria-label="Send in the local preview"
                  disabled={!draft.trim()}
                >
                  <SendHorizontal size={16} />
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function NewSessionProof({ titleId }: { titleId: string }) {
  const machineId = useId();
  const directoryId = useId();
  const instructionId = useId();
  const [machine, setMachine] = useState<(typeof MACHINES)[number]['id']>('workstation');
  const [directory, setDirectory] = useState<string>(PATHS[0]);
  const [agent, setAgent] = useState<AgentKey>('codex');
  const [instruction, setInstruction] = useState('Run the release checks and summarize any blocker.');
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
          <span>MULTI-AGENT LAUNCH</span>
          <span>EXPLICIT MACHINE SCOPE</span>
        </div>
        <h3 id={titleId}>Pick the machine, path, and agent. Then start.</h3>
        <p>
          The current Web launcher offers Claude, Codex, Gemini, and OpenClaw. The selected machine starts
          the agent—or connects its configured OpenClaw gateway. Gemini uses beta ACP; OpenClaw does not.
        </p>
      </div>

      <div className="cfp-surface" data-surface="launcher">
        <div className="cfp-surface-bar" aria-hidden="true">
          <span><i /> REAL NEW-SESSION UI</span>
          <span>SANITIZED DEMO · NO CONNECTION</span>
        </div>

        <form className="ns-card cfp-launcher" onSubmit={onReview}>
          <div className="cfp-ui-kicker">CURRENT WEB FLOW</div>
          <div className="ns-title">New agent session</div>

          <label className="ns-label" htmlFor={machineId}>Machine</label>
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

          <label className="ns-label" htmlFor={directoryId}>Directory</label>
          <div className="ns-presets" aria-label="Example directory presets">
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

          <label className="ns-label" htmlFor={instructionId}>Initial instruction</label>
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
            <span><strong>{agent}</strong> on {selectedMachine.label}</span>
            <code>{directory || 'choose a directory'}</code>
          </div>

          <div className="ns-actions">
            <span className="cfp-demo-note">Interactive preview only</span>
            <button className="cfp-launch-button" type="submit" disabled={!directory.trim()}>
              <TerminalSquare size={15} />
              Review launch
            </button>
          </div>

          <div className="cfp-launch-result" data-visible={reviewed} aria-live="polite">
            {reviewed && <><Sparkles size={14} aria-hidden="true" /> Selection ready. The signed-in app would create this session on {selectedMachine.label}.</>}
          </div>
        </form>
      </div>
    </article>
  );
}

export function CoreFeatureProofs() {
  const instanceId = useId();
  const sectionTitleId = `${instanceId}-core-feature-proofs-title`;
  const voiceTitleId = `${instanceId}-voice-proof-title`;
  const launchTitleId = `${instanceId}-launch-proof-title`;
  return (
    <section className="cfp" aria-labelledby={sectionTitleId}>
      <header className="cfp-heading">
        <div>
          <div className="cfp-eyebrow">CORE CAPABILITIES // SHOWN IN PRODUCT UI</div>
          <h2 id={sectionTitleId}>The feature claim and the interface, side by side.</h2>
        </div>
        <p>
          These are lightweight, data-only renderings of the production interaction contracts—not imaginary
          dashboards. Try the controls; nothing connects to a machine from this public page.
        </p>
      </header>

      <div className="cfp-grid">
        <VoiceCoordinatorProof titleId={voiceTitleId} />
        <NewSessionProof titleId={launchTitleId} />
      </div>
    </section>
  );
}
