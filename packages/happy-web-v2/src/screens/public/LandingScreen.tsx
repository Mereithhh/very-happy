import { ArrowRight, Braces, Github, Globe2, Server, ShieldCheck, TerminalSquare } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import { PublicFooter, PublicHeader } from './PublicShell';
import { DAEMON_START_COMMAND, GITHUB_URL, INSTALL_COMMAND, LOGIN_COMMAND } from './publicContent';
import './public.css';

const features = [
  { icon: TerminalSquare, title: 'Your machines, one console', text: 'Open terminals and Claude Code sessions from a responsive browser UI built for keyboard and touch.' },
  { icon: Braces, title: 'Work that stays in context', text: 'Move between sessions, machines, tasks, notes, and files without losing the thread of active work.' },
  { icon: Server, title: 'Cloud or self-hosted', text: 'Start on the community relay or run the server yourself. The same CLI connects to either deployment.' },
  { icon: ShieldCheck, title: 'An honest trust boundary', text: 'The relay is trusted and can access relayed data. We say that plainly so you can choose the right operator.' },
];

export function LandingScreen() {
  useEffect(() => { document.title = 'Very Happy — Remote coding from the browser'; }, []);
  return (
    <div className="pub-page">
      <PublicHeader />
      <main id="main-content">
        <section className="pub-hero" aria-labelledby="hero-title">
          <div className="pub-hero-copy">
            <div className="eyebrow">REMOTE CODING // BROWSER NATIVE</div>
            <h1 id="hero-title">Keep the machine.<br />Take the console.</h1>
            <p>Very Happy is an open-source web client and relay for Claude Code and remote terminals. Connect your own machine, then work from any modern browser.</p>
            <div className="pub-actions">
              <Link className="pub-button is-primary" to="/signup">Connect a machine <ArrowRight size={16} /></Link>
              <Link className="pub-button" to="/docs/quickstart">Read quick start</Link>
            </div>
            <div className="pub-meta mono"><span>Web V2</span><span>CLI + daemon</span><span>self-hostable</span></div>
          </div>
          <div className="pub-terminal" aria-label="Example Very Happy connection transcript">
            <div className="pub-terminal-bar"><span>machine / atlas</span><span className="pub-live"><i /> connected</span></div>
            <pre><code><span className="pub-prompt">$</span> {INSTALL_COMMAND}{'\n'}<span className="pub-prompt">$</span> {LOGIN_COMMAND}{'\n'}<span className="pub-prompt">$</span> {DAEMON_START_COMMAND}{'\n\n'}Machine <strong>atlas</strong> connected.{`\n\n`}<span className="pub-dim">~/code/project</span> <span className="pub-prompt">$</span> very-happy{`\n`}╭──────────────────────────────╮{`\n`}│ Ready. What should we build? │{`\n`}╰──────────────────────────────╯</code></pre>
          </div>
        </section>

        <section className="pub-trust" aria-labelledby="trust-title">
          <div><div className="eyebrow">TRUST MODEL</div><h2 id="trust-title">A relay you can reason about.</h2></div>
          <p>Very Happy is <strong>server-trusted, not end-to-end encrypted</strong>. Your relay operator—or anyone who compromises it—may access relayed content, account recovery material, and capabilities exposed by an online daemon. Use the community service if you trust its operator; self-host when you need to own that boundary.</p>
          <Link to="/docs/security">Read the security model <ArrowRight size={15} /></Link>
        </section>

        <section className="pub-section" aria-labelledby="features-title">
          <div className="pub-section-head"><div><div className="eyebrow">CAPABILITIES</div><h2 id="features-title">A terminal wearing a web browser.</h2></div><p>Fast enough for daily work, explicit enough for production operations.</p></div>
          <div className="pub-feature-grid">
            {features.map(({ icon: Icon, title, text }) => <article key={title}><Icon size={20} aria-hidden="true" /><h3>{title}</h3><p>{text}</p></article>)}
          </div>
        </section>

        <section className="pub-flow" aria-labelledby="flow-title">
          <div className="eyebrow">FIRST CONNECTION</div><h2 id="flow-title">From zero to a live machine.</h2>
          <ol>
            <li><span>01</span><div><h3>Create an account</h3><p>Use Google or username and password on your chosen relay.</p></div></li>
            <li><span>02</span><div><h3>Install the CLI</h3><code>{INSTALL_COMMAND}</code></div></li>
            <li><span>03</span><div><h3>Approve and connect</h3><code>{LOGIN_COMMAND}{'\n'}{DAEMON_START_COMMAND}</code></div></li>
            <li><span>04</span><div><h3>Start a session</h3><p>Run <code>very-happy</code> in a project folder, or select the connected machine in Web.</p></div></li>
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
          <div><div className="eyebrow">OPEN SOURCE</div><h2>Inspect it. Run it. Make it yours.</h2><p>Built in public from a heavily modified slopus/happy foundation.</p></div>
          <div className="pub-actions"><Link className="pub-button is-primary" to="/signup">Get started <ArrowRight size={16} /></Link><a className="pub-button" href={GITHUB_URL}><Github size={16} /> View source</a></div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
