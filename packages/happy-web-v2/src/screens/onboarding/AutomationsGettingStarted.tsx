import { ArrowRight, CalendarClock, ListTodo, Play, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { useAutomations } from '@/sync/automationsStore';
import { automationsGettingStartedCopy } from './automationsGettingStartedCopy';
import './teamGettingStarted.css';

/**
 * B-498: the Automations section shared by first-run and Help — same
 * surface as TeamGettingStarted. Documentation only: it renders whether or
 * not the server gate is on; the call to action degrades to the gate note
 * once the server said `automations_disabled`.
 */
export function AutomationsGettingStarted() {
  const { lang } = useTranslation();
  const copy = automationsGettingStartedCopy(lang);
  const enabled = useAutomations((s) => s.enabled);
  const icons = [CalendarClock, Play, ListTodo];
  return <section className="team-start" aria-label={copy.title}>
    <h2>{copy.title}</h2>
    <div className="team-start__features">
      <article>
        <h3><Zap size={22} aria-hidden="true" />{copy.eyebrow}</h3>
        <p>{copy.intro}</p>
        <ol className="team-start__flow">{copy.steps.map((step, index) => {
          const Icon = icons[index];
          return <li key={step}><Icon size={20} aria-hidden="true" /><span>{step}</span></li>;
        })}</ol>
        <blockquote>{copy.example}</blockquote>
        <p><strong>{copy.createTitle}</strong></p>
        <ul className="team-start__list">
          <li>{copy.createWeb}</li>
          <li>{copy.createCli}</li>
          <li>{copy.createSession}</li>
        </ul>
        <p><strong>{copy.triggerTitle}</strong> {copy.triggerNote}</p>
        {enabled === false
          ? <p className="team-start__limit">{copy.gate}</p>
          : <Link to="/automations/new">{copy.open}<ArrowRight size={15} /></Link>}
      </article>
      <article>
        <h3><ListTodo size={22} aria-hidden="true" />{copy.decisions}</h3>
        <p>{copy.decisionsNote}</p>
        <p className="team-start__limit">{copy.limit}</p>
        <Link to="/docs/automations">{copy.docs}<ArrowRight size={15} /></Link>
      </article>
    </div>
  </section>;
}
