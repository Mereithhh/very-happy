import { ArrowRight } from 'lucide-react';
import './whyVeryHappy.css';

const VALUE_ROUTES = [
  {
    friction: 'Agents and terminals are scattered across several machines.',
    title: 'One panel holds the fleet.',
    outcome: 'Sessions, status, tasks, and attention state gather around the machine and agent you choose.',
  },
  {
    friction: 'Structured chat is pleasant—until the actual tool needs your hands.',
    title: 'Structured when useful. Native when necessary.',
    outcome: 'Follow the readable conversation, then step into the same durable TTY when raw control matters.',
  },
  {
    friction: 'Leaving the desk makes active work difficult to follow.',
    title: 'Carry the work between screens.',
    outcome: 'The responsive Web and PWA keep conversations, terminals, files, and decisions within reach.',
  },
  {
    friction: 'Remote control has to fit your operating model.',
    title: 'Choose the operator—not another silo.',
    outcome: 'Start with Very Happy Cloud or run the same open-source stack with your own policy and storage.',
  },
] as const;

export function WhyVeryHappy() {
  return <section className="why-vh" aria-labelledby="why-vh-title">
    <header className="why-vh-head">
      <div>
        <div className="eyebrow">WHY VERY HAPPY // OVERHEAD ROUTING</div>
        <h2 id="why-vh-title">The work is already complex.<br /><span>The interface shouldn&apos;t add to it.</span></h2>
      </div>
      <p>Very Happy does not replace the machines and tools that already work. It carries the coordination overhead between them.</p>
    </header>

    <div className="why-vh-routes" role="list" aria-label="Friction carried by Very Happy">
      {VALUE_ROUTES.map((route, index) => <article className="why-vh-route" role="listitem" key={route.title}>
        <div className="why-vh-friction">
          <span className="mono">FRICTION {String(index + 1).padStart(2, '0')}</span>
          <p>{route.friction}</p>
        </div>
        <div className="why-vh-signal" aria-hidden="true">
          <span className="why-vh-signal-origin" />
          <span className="why-vh-signal-line"><i /></span>
          <ArrowRight size={17} />
        </div>
        <div className="why-vh-outcome">
          <span className="mono">CARRIED BY VERY HAPPY</span>
          <h3>{route.title}</h3>
          <p>{route.outcome}</p>
        </div>
      </article>)}
    </div>
    <div className="why-vh-foot mono"><span>KEEP THE TOOLS</span><span>LOSE THE PATROL WORK</span><strong>HUMAN IN CONTROL</strong></div>
  </section>;
}
