import { ArrowRight, Cable, Github, Globe2, Laptop, MonitorSmartphone, Server, Sparkles, TerminalSquare } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEffect, type PointerEvent as ReactPointerEvent } from 'react';
import { PublicFooter, PublicHeader } from './PublicShell';
import { CoreFeatureProofs } from './CoreFeatureProofs';
import { KeyboardWorkflowProof } from './KeyboardWorkflowProof';
import { MobileContinuityProof } from './MobileContinuityProof';
import { ProductWorkspacePreview } from './ProductWorkspacePreview';
import { SchedulerTopologyProof } from './SchedulerTopologyProof';
import { DAEMON_START_COMMAND, GITHUB_URL, INSTALL_COMMAND, LOGIN_COMMAND } from './publicContent';
import './public.css';

function ProductShowcase() {
  return <section className="pub-product" aria-labelledby="product-title">
    <div className="pub-product-intro"><div><div className="eyebrow">ONE PANEL // MANY RUNNERS</div><h2 id="product-title">Command the fleet without babysitting every process.</h2></div><p>The account sidebar brings sessions from connected machines and different agents into one operating view. See what is running, what is waiting, and what needs you; choose a machine and agent for new work; then open its structured conversation, real terminal, files, or task board without changing control planes.</p></div>
    <div className="pub-product-frame"><div className="pub-product-frame-head mono"><span><i /> ACCOUNT WORKSPACE · PRODUCTION UI CONTRACTS</span><span>3 MACHINES · CLAUDE + CODEX + TTY</span></div><ProductWorkspacePreview /></div>
    <div className="pub-product-caption mono"><span>ONE SIDEBAR · MULTI-MACHINE WORK</span><span>DISPATCH · WATCH · STEP IN</span></div>
  </section>;
}

function WebFirstSurface() {
  return <section className="pub-web-first" aria-labelledby="web-first-title">
    <div className="pub-web-first-copy">
      <div className="eyebrow">WEB FIRST // TERMINAL UNIVERSAL</div>
      <h2 id="web-first-title">Your fleet in the Web.<br /><span>The work on real machines.</span></h2>
      <p><strong>The Web/PWA is the recommended daily command surface.</strong> Install the CLI on each machine you want to reach and leave its daemon running; the account workspace then gathers their terminals, conversations, files, tasks, and attention states into the screen already in your hand.</p>
      <div className="pub-web-first-stack">
        <article><MonitorSmartphone size={18} /><div><h3>Web / PWA</h3><p>Your unified command panel on desktop, tablet, and phone.</p></div></article>
        <article><Cable size={18} /><div><h3>CLI + daemon</h3><p>The machine-side bridge for pairing, diagnostics, automation, and local escape hatches.</p></div></article>
        <article><TerminalSquare size={18} /><div><h3>tmux + real TTY</h3><p>The compatibility layer for ordinary xterm-256color text TUIs—not only coding agents.</p></div></article>
      </div>
      <Link to="/docs/architecture">See the architecture <ArrowRight size={15} /></Link>
    </div>
    <div className="pub-web-first-proof">
      <div className="pub-web-first-window">
        <div className="pub-web-first-window-head mono"><span><i /> WEB / PWA · RECOMMENDED</span><span>SANITIZED PRODUCT PREVIEW</span></div>
        <ProductWorkspacePreview compact initialView="terminal" initialFilesOpen={false} />
      </div>
      <div className="pub-compat-rail mono" aria-label="Examples of terminal-native tools carried by the same tmux terminal path">
        <span>SHELL</span><span>VIM</span><span>LAZYGIT</span><span>SSH</span><span>TEXT TUI</span>
      </div>
      <div className="pub-mcp-rail">
        <div><span className="mono">MCP HANDOFFS</span><strong>Managed runners can hand off titles, clipboard text, and file previews; Claude also reports progress. The optional meta-agent has a separate high-privilege local control surface.</strong></div>
        <Link to="/docs/integrations">Exact tool matrix <ArrowRight size={14} /></Link>
      </div>
    </div>
  </section>;
}

function HeroProductStage() {
  const tiltStage = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse') return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    event.currentTarget.style.setProperty('--stage-ry', `${x * 9}deg`);
    event.currentTarget.style.setProperty('--stage-rx', `${y * -7}deg`);
  };
  const resetStage = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.style.setProperty('--stage-ry', '0deg');
    event.currentTarget.style.setProperty('--stage-rx', '0deg');
  };

  return <div className="pub-hero-stage" onPointerMove={tiltStage} onPointerLeave={resetStage}>
    <div className="pub-stage-fabric mono" aria-hidden="true">
      <span className="pub-stage-orbit pub-stage-orbit--outer" />
      <span className="pub-stage-orbit pub-stage-orbit--inner" />
      <span className="pub-stage-scan" />
      <span className="pub-stage-link pub-stage-link--one" />
      <span className="pub-stage-link pub-stage-link--two" />
      <span className="pub-stage-link pub-stage-link--three" />
      <span className="pub-stage-packet pub-stage-packet--one" />
      <span className="pub-stage-packet pub-stage-packet--two" />
      <span className="pub-stage-packet pub-stage-packet--three" />
    </div>
    <div className="pub-stage-float"><aside className="pub-hero-product" aria-label="Interactive sanitized Very Happy scheduler system map">
      <div className="pub-hero-product-head mono"><span><i /> INTERACTIVE SYSTEM MAP · CURRENT PATHS</span><span>MACHINES × AGENTS</span></div>
      <SchedulerTopologyProof />
      <div className="pub-hero-product-foot mono"><span>PHONE / WEB CONTROL PLANE</span><span>SELECT · DISPATCH · STEP IN</span></div>
    </aside></div>
    <div className="pub-stage-telemetry mono" aria-hidden="true"><span>ONE ACCOUNT</span><span>MANY RUNTIMES</span><span>HUMAN IN CONTROL</span></div>
  </div>;
}

export function LandingScreen() {
  useEffect(() => { document.title = 'Very Happy — One panel for every machine and agent.'; }, []);
  return <div className="pub-page"><PublicHeader /><main id="main-content">
    <section className="pub-hero" aria-labelledby="hero-title"><div className="pub-hero-copy"><div className="eyebrow">MULTI-MACHINE COMMAND PANEL</div><h1 id="hero-title" className="pub-fleet-title">One panel.<br /><span>Every machine.<br />Every agent.</span></h1><p>Open the Web or PWA, choose a connected machine and agent, then dispatch the work. Step into any live terminal, conversation, file, or task without rebuilding context.</p><div className="pub-hero-thesis mono"><span>SEE THE FLEET.</span><strong>DISPATCH THE WORK. STEP IN ANYWHERE.</strong></div><div className="pub-actions"><a className="pub-button is-primary" href={`${import.meta.env.BASE_URL}signup`}>Connect your first machine <ArrowRight size={16} /></a><Link className="pub-button" to="/docs/quickstart">See how it works</Link></div><div className="pub-meta mono"><span>Web / PWA command surface</span><span>Choose machine + agent per session</span><span>self-hostable</span></div></div><HeroProductStage /></section>
    <ProductShowcase />
    <WebFirstSurface />
    <KeyboardWorkflowProof />
    <MobileContinuityProof />
    <section className="pub-agents" aria-labelledby="agents-title"><div className="pub-section-head"><div><div className="eyebrow">AGENTS ARE AN UPGRADE, NOT A BOUNDARY</div><h2 id="agents-title">Bring the agent—or terminal tool—that fits the work.</h2></div><p>Structured adapters add richer semantics. The tmux/TTY path stays useful even when the process is not a coding agent at all.</p></div><div className="pub-agent-grid"><article><div className="pub-status mono">DEEPEST SUPPORT</div><h3>Claude Code</h3><p>Choose SDK-native structured sessions or, with tmux installed, the actual Claude Code TUI in a durable terminal. tmux 3.2+ enables optional hooks for its structured mirror.</p></article><article><div className="pub-status mono">AVAILABLE NOW</div><h3>Codex</h3><p>Start and resume Codex on a connected machine through the same CLI, trusted relay, and responsive terminal workspace.</p></article><article><div className="pub-status mono">BETA · IMPLEMENTED</div><h3>Gemini + OpenCode via ACP</h3><p>The CLI ships an Agent Client Protocol backend and generic runner. The agent command must expose a compatible ACP stdio endpoint.</p></article><article className="is-roadmap"><div className="pub-status mono">ROADMAP</div><h3>Pi + provider gateway</h3><p>Cross-provider subtask dispatch and a coordinator that routes work to the best available agent.</p></article></div></section>
    <section className="pub-flow" aria-labelledby="flow-title"><div className="eyebrow">FIRST CONNECTION</div><h2 id="flow-title">From zero to a live agent in six steps.</h2><ol><li><span>01</span><div><h3>Create an account</h3><p>Use Google or username and password on your chosen relay.</p></div></li><li><span>02</span><div><h3>Install + check</h3><code>{`${INSTALL_COMMAND}\nvery-happy doctor`}</code><p>Node 20.19+ within 20.x, 22.13+ within 22.x, or 24+ is required. tmux is recommended for durable terminals.</p></div></li><li><span>03</span><div><h3>Configure the agent</h3><code>{'ANTHROPIC_API_KEY or cloud provider\nvery-happy doctor'}</code><p>Use the daemon user's environment. Doctor never prints the secret.</p></div></li><li><span>04</span><div><h3>Connect the machine</h3><code>{LOGIN_COMMAND}</code></div></li><li><span>05</span><div><h3>Start the daemon</h3><code>{DAEMON_START_COMMAND}</code><p>Starts in the background and captures that environment.</p></div></li><li><span>06</span><div><h3>Choose an agent</h3><code>{'Web → New session\nchoose machine + agent'}</code><p>Bundled structured Claude starts here; local modes use their installed agent command.</p></div></li></ol></section>
    <section className="pub-trust" aria-labelledby="trust-title"><div><div className="eyebrow">TRUST MODEL</div><h2 id="trust-title">A relay you can reason about.</h2></div><p>Very Happy is <strong>server-trusted, not end-to-end encrypted</strong>. A relay operator—or anyone who compromises it—may access relayed content, account recovery material, and capabilities exposed by an online daemon. Use the community service if you trust its operator; self-host when you need to own that boundary.</p><Link to="/docs/security">Read the security model <ArrowRight size={15} /></Link></section>
    <section className="pub-choices" aria-labelledby="deploy-title"><div className="pub-section-head"><div><div className="eyebrow">DEPLOYMENT</div><h2 id="deploy-title">Choose who operates the relay.</h2></div></div><div className="pub-choice-grid"><article><Globe2 size={22} /><h3>Very Happy Cloud</h3><p>The quickest start. Community-operated, capacity-limited, and provided without an uptime SLA.</p><Link to="/docs/cloud">Cloud guide <ArrowRight size={14} /></Link></article><article><Server size={22} /><h3>Self-hosted</h3><p>Your access policy, storage, backups, and operator boundary. Still server-trusted by design.</p><Link to="/docs/self-hosting">Self-hosting guide <ArrowRight size={14} /></Link></article></div></section>
    <section className="pub-manifesto" aria-labelledby="manifesto-title"><div className="eyebrow">WHY VERY HAPPY</div><h2 id="manifesto-title">The interface carries the overhead.<br /><span>You get to be Very Happy.</span></h2><p>Fewer tabs to patrol, less context to rebuild, and more attention left for the decisions only you can make.</p><div className="pub-manifesto-line mono"><span>LESS BABYSITTING</span><span>LESS CONTEXT REBUILDING</span><span>MORE WORK IN MOTION</span></div></section>
    <CoreFeatureProofs />
    <section className="pub-orchestration" aria-labelledby="orchestration-title"><div><div className="eyebrow">ONE ACCOUNT // MANY MACHINES</div><h2 id="orchestration-title">See the fleet. Dispatch the work. Step in for judgment.</h2><p>Sessions, status, tasks, notes, voice, webhooks, and local adapters converge in one Web panel. Today you explicitly choose the target machine and agent for each session; provider-neutral automatic routing and a visible multi-agent office remain roadmap.</p><Link to="/docs/integrations">Explore integrations <ArrowRight size={15} /></Link></div><div className="pub-fleet" aria-label="Sanitized account command panel with three connected machines"><div className="pub-fleet-head mono"><span>FLEET COMMAND / SANITIZED</span><span><i /> 3 CONNECTED</span></div><div className="pub-fleet-row"><span><Server size={15} /> build-server</span><strong>Codex · running tests</strong><small className="mono">02:18</small></div><div className="pub-fleet-row"><span><Laptop size={15} /> workstation</span><strong>Claude · awaiting review</strong><small className="mono">00:42</small></div><div className="pub-fleet-row"><span><Server size={15} /> staging</span><strong>terminal · healthy</strong><small className="mono">DEMO</small></div><div className="pub-fleet-foot mono"><Sparkles size={14} /> NEW SESSION → CHOOSE MACHINE + AGENT</div></div></section>
    <section className="pub-final"><div><div className="eyebrow">WORK ANYWHERE</div><h2>Keep the machine. Lose the overhead.</h2><p>Open source, self-hostable, and built from a heavily modified slopus/happy foundation.</p></div><div className="pub-actions"><a className="pub-button is-primary" href={`${import.meta.env.BASE_URL}signup`}>Get started <ArrowRight size={16} /></a><a className="pub-button" href={GITHUB_URL}><Github size={16} /> View source</a></div></section>
  </main><PublicFooter /></div>;
}
