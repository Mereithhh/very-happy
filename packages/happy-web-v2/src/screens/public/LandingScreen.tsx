import { ArrowRight, AudioLines, Braces, FileText, Github, Globe2, MessagesSquare, Server, Sparkles, TerminalSquare } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import { PublicFooter, PublicHeader } from './PublicShell';
import { DAEMON_START_COMMAND, GITHUB_URL, INSTALL_COMMAND, LOGIN_COMMAND } from './publicContent';
import './public.css';

const features = [
  { icon: MessagesSquare, title: 'Conversation when it helps', text: 'Use a calm, structured view for messages, tools, diffs, permissions, and context—not a phone-sized terminal transcript.' },
  { icon: TerminalSquare, title: 'A real terminal when it matters', text: 'Drop into a durable tmux terminal, then switch a mirrored Claude session back to its structured conversation.' },
  { icon: FileText, title: 'The work around the agent', text: 'Browse and preview files, keep notes, and coordinate the task board without rebuilding context in another app.' },
  { icon: AudioLines, title: 'A Claude-powered meta-agent', text: 'Use text—or voice when a voice service is configured—to reach a coordinating assistant. This feature currently requires Claude Code.' },
];

export function LandingScreen() {
  useEffect(() => { document.title = 'Very Happy — Work anywhere. Keep the thread.'; }, []);
  return (
    <div className="pub-page">
      <PublicHeader />
      <main id="main-content">
        <section className="pub-hero" aria-labelledby="hero-title">
          <div className="pub-hero-copy">
            <div className="eyebrow">OPEN AGENT WORKSPACE // YOUR MACHINES</div>
            <h1 id="hero-title">Work anywhere.<br /><span>Keep the thread.</span></h1>
            <p>Very Happy brings coding agents, terminals, files, tasks, and a voice-ready meta-agent into one mobile-friendly workspace. The work runs on your machines; the context follows you.</p>
            <div className="pub-actions">
              <a className="pub-button is-primary" href={`${import.meta.env.BASE_URL}signup`}>Connect a machine <ArrowRight size={16} /></a>
              <Link className="pub-button" to="/docs/quickstart">Read quick start</Link>
            </div>
            <div className="pub-meta mono"><span>Claude + Codex</span><span>ACP extensible</span><span>self-hostable</span></div>
          </div>
          <div className="pub-workbench" aria-label="Very Happy workspace showing an agent conversation, files, and task progress">
            <div className="pub-workbench-bar"><span className="mono">atlas / very-happy</span><span className="pub-live"><i /> agent working</span></div>
            <div className="pub-workbench-tabs mono"><span className="is-active">Conversation</span><span>Terminal</span><span>Files</span></div>
            <div className="pub-workbench-body">
              <aside aria-label="Agent sessions"><b>SESSIONS</b><span className="is-active">Launch polish</span><span>Security review</span><span>Docs pass</span></aside>
              <div className="pub-workbench-chat">
                <div className="pub-agent-line"><span>YOU</span><p>Make the first-run path feel effortless on mobile.</p></div>
                <div className="pub-agent-line is-agent"><span>CLAUDE · ATLAS</span><p>I traced onboarding and found two dead ends. Fixing the empty state and adding a recovery action now.</p></div>
                <div className="pub-tool-line mono"><Braces size={13} /> Editing src/onboarding/EmptyState.tsx</div>
                <div className="pub-agent-line is-agent"><span>CLAUDE · ATLAS</span><p>Checks passed. Mobile focus and reduced-motion behavior both look good.</p></div>
              </div>
              <aside className="pub-workbench-context" aria-label="Task and file context"><b>NOW</b><span><i className="is-done" /> Map first run</span><span><i className="is-live" /> Fix empty state</span><span><i /> Browser verify</span><b>FILES</b><span>EmptyState.tsx</span><span>onboarding.css</span></aside>
            </div>
          </div>
        </section>

        <section className="pub-manifesto" aria-labelledby="manifesto-title">
          <div className="eyebrow">THE DIFFERENCE</div>
          <h2 id="manifesto-title">Not remote control.<br />A place to finish the work.</h2>
          <p>A remote shell gets you back to a cursor. Very Happy gets you back to the decision: the conversation, the changed files, the open tasks, the waiting permission, and the next agent that can help.</p>
          <div className="pub-manifesto-line mono"><span>LESS TAB HUNTING</span><span>LESS CONTEXT REBUILDING</span><span>LESS WORK HELD IN YOUR HEAD</span></div>
        </section>

        <section className="pub-trust" aria-labelledby="trust-title">
          <div><div className="eyebrow">TRUST MODEL</div><h2 id="trust-title">A relay you can reason about.</h2></div>
          <p>Very Happy is <strong>server-trusted, not end-to-end encrypted</strong>. Your relay operator—or anyone who compromises it—may access relayed content, account recovery material, and capabilities exposed by an online daemon. Use the community service if you trust its operator; self-host when you need to own that boundary.</p>
          <Link to="/docs/security">Read the security model <ArrowRight size={15} /></Link>
        </section>

        <section className="pub-section" aria-labelledby="features-title">
          <div className="pub-section-head"><div><div className="eyebrow">ONE WORK SURFACE</div><h2 id="features-title">Use the right interface for the moment.</h2></div><p>Stay high-level when you can. Reach the raw machine whenever you need it.</p></div>
          <div className="pub-feature-grid">
            {features.map(({ icon: Icon, title, text }) => <article key={title}><Icon size={20} aria-hidden="true" /><h3>{title}</h3><p>{text}</p></article>)}
          </div>
        </section>

        <section className="pub-agents" aria-labelledby="agents-title">
          <div className="pub-section-head"><div><div className="eyebrow">AGENTS, NOT A WALLED GARDEN</div><h2 id="agents-title">One workspace. More than one agent.</h2></div><p>The interface follows your work instead of forcing every task through one vendor.</p></div>
          <div className="pub-agent-grid">
            <article><div className="pub-status mono">AVAILABLE NOW</div><h3>Claude Code</h3><p>Deep structured conversation, tool and permission views, terminal mirroring, files, usage, and resume.</p></article>
            <article><div className="pub-status mono">AVAILABLE NOW</div><h3>Codex</h3><p>Start and resume Codex sessions through the same CLI, relay, responsive workspace, and machine fleet.</p></article>
            <article><div className="pub-status mono">EXTENSIBLE NOW</div><h3>ACP agents</h3><p>Gemini ships as an ACP mode, and a generic ACP runner can connect compatible commands such as OpenCode.</p></article>
            <article className="is-roadmap"><div className="pub-status mono">ROADMAP</div><h3>Pi + provider gateway</h3><p>More adapters, cross-provider subtask dispatch, and a meta-agent that routes work to the best available agent.</p></article>
          </div>
        </section>

        <section className="pub-vision" aria-labelledby="vision-title">
          <div><div className="eyebrow">NORTH STAR</div><h2 id="vision-title">The interface should carry the overhead.</h2></div>
          <div className="pub-vision-copy"><p>Our roadmap is not “put more buttons around a terminal.” It is to make ambitious work feel lighter: persistent context, useful interruptions, agent handoffs, task memory, and presence across desktop and mobile.</p><p><strong>Long term:</strong> a multi-agent virtual office where people can see work move, talk to a coordinator, and step into the right room only when judgment is needed. The pixel office is a concept, not a shipped feature.</p></div>
          <Sparkles aria-hidden="true" size={28} />
        </section>

        <section className="pub-flow" aria-labelledby="flow-title">
          <div className="eyebrow">FIRST CONNECTION</div><h2 id="flow-title">Your first agent, in four steps.</h2>
          <ol>
            <li><span>01</span><div><h3>Create an account</h3><p>Use Google or username and password on your chosen relay.</p></div></li>
            <li><span>02</span><div><h3>Install the CLI</h3><code>{INSTALL_COMMAND}</code></div></li>
            <li><span>03</span><div><h3>Approve and connect</h3><code>{LOGIN_COMMAND}{'\n'}{DAEMON_START_COMMAND}</code></div></li>
            <li><span>04</span><div><h3>Choose an agent</h3><p>Run <code>very-happy</code> for Claude, <code>very-happy codex</code>, or create a session from Web.</p></div></li>
          </ol>
        </section>

        <section className="pub-choices" aria-labelledby="deploy-title">
          <div className="pub-section-head"><div><div className="eyebrow">DEPLOYMENT</div><h2 id="deploy-title">Choose who operates the relay.</h2></div></div>
          <div className="pub-choice-grid">
            <article><Globe2 size={22} /><h3>Very Happy Cloud</h3><p>The quickest start. Community-operated, capacity-limited, and provided without an uptime SLA.</p><Link to="/docs/cloud">Cloud guide <ArrowRight size={14} /></Link></article>
            <article><Server size={22} /><h3>Self-hosted</h3><p>Your access policy, storage, backups, and operator boundary. Still server-trusted by design.</p><Link to="/docs/self-hosting">Self-hosting guide <ArrowRight size={14} /></Link></article>
          </div>
        </section>

        <section className="pub-final">
          <div><div className="eyebrow">WORK ANYWHERE</div><h2>Keep the machine. Lose the overhead.</h2><p>Open source, self-hostable, and built from a heavily modified slopus/happy foundation.</p></div>
          <div className="pub-actions"><a className="pub-button is-primary" href={`${import.meta.env.BASE_URL}signup`}>Get started <ArrowRight size={16} /></a><a className="pub-button" href={GITHUB_URL}><Github size={16} /> View source</a></div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
