import { useState } from 'react';
import { ArrowRight, Bot, CheckCheck, ListChecks, Network, Target } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { Command } from './ConnectMachineGuide';
import { teamGettingStartedCopy, teamSkillInstallCommand, type TeamSkillHost } from './teamGettingStartedCopy';
import './teamGettingStarted.css';

export function TeamGettingStarted() {
  const { lang } = useTranslation();
  const copy = teamGettingStartedCopy(lang);
  const [host, setHost] = useState<TeamSkillHost>('claude');
  const icons = [Target, Network, CheckCheck];
  return <section className="team-start" aria-label={copy.title}>
    <h2>{copy.title}</h2>
    <div className="team-start__features">
      <article>
        <h3><Bot size={22} aria-hidden="true" />{copy.bot}</h3>
        <ol className="team-start__flow">{copy.steps.map((step, index) => {
          const Icon = icons[index];
          return <li key={step}><Icon size={20} aria-hidden="true" /><span>{step}</span></li>;
        })}</ol>
        <blockquote>{copy.example}</blockquote>
        <p>{copy.botNote}</p>
        <Link to="/teams">{copy.teams}<ArrowRight size={15} /></Link>
      </article>
      <article>
        <h3><ListChecks size={22} aria-hidden="true" />{copy.todos}</h3>
        <p>{copy.todoNote}</p>
        <Link to="/todos">{copy.openTodos}<ArrowRight size={15} /></Link>
      </article>
    </div>
    <div className="team-start__install">
      <h3>{copy.install}</h3>
      <p>{copy.instruction}</p>
      <label>{copy.host}<select value={host} onChange={event => setHost(event.target.value as TeamSkillHost)}>
        <option value="claude">Claude Code</option><option value="codex">Codex</option><option value="pi">pi</option>
      </select></label>
      <Command value={teamSkillInstallCommand(host)} />
      <p className="team-start__limit">{copy.limit}</p>
      <Link to="/docs/agent-teams">{copy.docs}<ArrowRight size={15} /></Link>
    </div>
  </section>;
}
