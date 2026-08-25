import { ArrowRight, Cable, Github, Globe2, MonitorSmartphone, Server, TerminalSquare } from 'lucide-react';
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
    <div className="pub-product-intro"><div><div className="eyebrow">REAL PRODUCT // SANITIZED DATA</div><h2 id="product-title">See the fleet. Open the work.</h2></div><p>This is the interface you actually use: sessions from multiple machines in one sidebar, with the live terminal, structured Claude mirror, files, previews, and task board one click away.</p></div>
    <div className="pub-product-frame"><div className="pub-product-frame-head mono"><span><i /> ACCOUNT WORKSPACE · PRODUCTION UI CONTRACTS</span><span>3 MACHINES · CLAUDE + CODEX + TTY</span></div><ProductWorkspacePreview fileTransferDemo /></div>
    <div className="pub-product-caption mono"><span>ONE SIDEBAR · MULTI-MACHINE WORK</span><span>PASTE FILE → TRUSTED RELAY → QUOTED PATH · 8 MB · NO AUTO-RUN</span><span>DISPATCH · WATCH · STEP IN</span></div>
    <div className="pub-product-facts">
      <article><MonitorSmartphone size={18} /><div><span className="mono">WEB / PWA · RECOMMENDED</span><strong>The recommended daily command surface on desktop, tablet, and phone.</strong></div></article>
      <article><Cable size={18} /><div><span className="mono">CLI + DAEMON + TMUX</span><strong>The machine-side bridge keeps ordinary xterm-256color text TUIs—not only coding agents—reachable.</strong></div></article>
      <article><TerminalSquare size={18} /><div><span className="mono">AGENT FABRIC · SHIPPED + BETA + ROADMAP</span><strong>Claude Code deep support · Codex available · Gemini + OpenCode via a compatible ACP stdio endpoint (BETA · IMPLEMENTED) · any text TUI. Pi + provider gateway remain roadmap; today you explicitly choose the machine and agent.</strong></div></article>
    </div>
    <div className="pub-product-links"><Link to="/docs/architecture">Architecture <ArrowRight size={14} /></Link><Link to="/docs/integrations">Agent and MCP matrix <ArrowRight size={14} /></Link></div>
  </section>;
}

function StartAndTrust() {
  return <section className="pub-start" aria-labelledby="start-title">
    <div className="pub-start-main">
      <div className="eyebrow">FIRST CONNECTION // THREE MOVES</div>
      <h2 id="start-title">From account to live work.</h2>
      <ol>
        <li><span className="mono">01</span><div><h3>Create an account</h3><p>Use Google or username and password on your chosen relay.</p></div></li>
        <li><span className="mono">02</span><div><h3>Prepare the machine</h3><code>{`${INSTALL_COMMAND}\nvery-happy doctor`}</code><p>Node 20.19+ within 20.x, 22.13+ within 22.x, or 24+ is required. Configure the local agent; tmux is recommended for durable terminals.</p></div></li>
        <li><span className="mono">03</span><div><h3>Connect and keep it online</h3><code>{`${LOGIN_COMMAND}\n${DAEMON_START_COMMAND}`}</code><p>Then open Web → New session and choose the machine plus agent.</p></div></li>
      </ol>
      <Link className="pub-start-guide" to="/docs/quickstart">Complete quick start <ArrowRight size={15} /></Link>
    </div>
    <aside className="pub-start-trust" aria-labelledby="trust-title">
      <div className="eyebrow">TRUST MODEL</div>
      <h2 id="trust-title">Choose the relay boundary.</h2>
      <p>Very Happy is <strong>server-trusted, not end-to-end encrypted</strong>. The operator—or an attacker controlling the relay—may access relayed content, recovery material, and capabilities exposed by an online daemon.</p>
      <div className="pub-start-choice"><Globe2 size={18} /><div><strong>Very Happy Cloud</strong><span>Fastest start · capacity-limited · no uptime SLA</span></div><Link to="/docs/cloud" aria-label="Read the Very Happy Cloud guide"><ArrowRight size={15} /></Link></div>
      <div className="pub-start-choice"><Server size={18} /><div><strong>Self-hosted</strong><span>Your operator, access policy, storage, and backups</span></div><Link to="/docs/self-hosting" aria-label="Read the self-hosting guide"><ArrowRight size={15} /></Link></div>
      <Link className="pub-start-security" to="/docs/security">Read the complete security model <ArrowRight size={15} /></Link>
    </aside>
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
    <CoreFeatureProofs />
    <MobileContinuityProof />
    <KeyboardWorkflowProof compact />
    <StartAndTrust />
    <section className="pub-final"><div><div className="eyebrow">WHY VERY HAPPY // WORK ANYWHERE</div><h2>The interface carries the overhead.<br /><span>You get to be Very Happy.</span></h2><p>Fewer tabs to patrol, less context to rebuild, and more attention left for the decisions only you can make.</p></div><div className="pub-actions"><a className="pub-button is-primary" href={`${import.meta.env.BASE_URL}signup`}>Connect your first machine <ArrowRight size={16} /></a><a className="pub-button" href={GITHUB_URL}><Github size={16} /> View source</a></div></section>
  </main><PublicFooter /></div>;
}
