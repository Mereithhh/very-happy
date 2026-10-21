import { useState } from 'react';
import { ArrowRight, Bot, CheckCheck, ListChecks, Network, Target } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { Command } from './ConnectMachineGuide';
import { teamGettingStartedCopy, teamSkillInstallCommand, type TeamSkillHost } from './teamGettingStartedCopy';
import { Segmented } from '@/ui/Segmented';
import { Summary } from '@/ui/Summary';
import './teamGettingStarted.css';

const HOSTS: { value: TeamSkillHost; label: string }[] = [{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }, { value: 'pi', label: 'pi' }];

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
        <Link to="/teams?new=1">{copy.teams}<ArrowRight size={15} /></Link>
      </article>
      <article>
        <h3><ListChecks size={22} aria-hidden="true" />{copy.todos}</h3>
        <p>{copy.todoNote}</p>
        <Link to="/todos">{copy.openTodos}<ArrowRight size={15} /></Link>
      </article>
    </div>
    <details id="team-skill-install" className="team-start__install">
      <Summary>{copy.install}</Summary>
      <p>{copy.instruction}</p>
      <div className="team-start__host"><span id="team-skill-host">{copy.host}</span><Segmented labelledBy="team-skill-host" value={host} onChange={setHost} options={HOSTS} /></div>
      <Command value={teamSkillInstallCommand(host)} />
      <p className="team-start__limit">{copy.limit}</p>
      <Link to="/docs/agent-teams">{copy.docs}<ArrowRight size={15} /></Link>
    </details>
  </section>;
}
