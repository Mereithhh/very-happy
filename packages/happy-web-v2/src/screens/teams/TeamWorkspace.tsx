import type { TeamState } from '@slopus/happy-wire';
import { Link } from 'react-router-dom';
import { Bot, Circle, CircleCheck, CircleDashed, Clock3, ArrowUpRight, GitBranch, Monitor } from 'lucide-react';
import { useWorkspaceCopy } from './workspaceCopy';
import { t as tr } from '@/text';
import { taskRows } from './teamView';

export function TeamProgress({ team }: { team: TeamState }) {
  const c = useWorkspaceCopy();
  const done = team.tasks.filter(t => t.status === 'done').length;
  return <div className="teams-progress"><progress aria-label={c.progress} max={Math.max(1, team.tasks.length)} value={done} /><span>{done}/{team.tasks.length} {c.progress}</span></div>;
}

export function TeamWorkspace({ team, onTask }: { team: TeamState; onTask: (id: string) => void }) {
  const c = useWorkspaceCopy();
  const rows = taskRows(team.tasks);
  const lanes = [
    { key: 'queued', label: c.queued, Icon: CircleDashed },
    { key: 'running', label: c.running, Icon: Clock3 },
    { key: 'submitted', label: c.submitted, Icon: Circle },
    { key: 'finished', label: c.finished, Icon: CircleCheck },
  ];
  return <>
    <section className="teams-members"><h2>{c.members} <small>{team.bots.length}</small></h2>
      {team.bots.length === 0 && <p>{c.noMembers}</p>}
      <div className="teams-members-grid">{team.bots.map(bot => {
        const active = team.tasks.filter(t => t.assigneeBotId === bot.id && !['done', 'cancelled'].includes(t.status));
        const content = <><span className="teams-avatar"><Bot size={22} /></span><span className="teams-member-info"><strong>{bot.name}</strong><small>{bot.root ? c.lead : bot.assistant === 'pi-acp' ? 'pi' : bot.assistant}</small><span>{!bot.sessionId ? tr('teams.starting') : active.length ? `${c.assigned} · ${active.length}` : c.idle}</span>{bot.lastEvent && <small>{c.lastEvent} · {tr(`teams.${bot.lastEvent}`)}{bot.lastEventAt ? ` · ${new Date(bot.lastEventAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}` : ''}</small>}</span>{bot.sessionId && <ArrowUpRight size={16} aria-hidden />}</>;
        return bot.sessionId ? <Link key={bot.id} className="teams-member" to={`/session/${encodeURIComponent(bot.sessionId)}`}>{content}</Link> : <div key={bot.id} className="teams-member">{content}</div>;
      })}</div>
    </section>
    <section className="teams-work"><div className="teams-section-heading"><h2>{c.overview}</h2><TeamProgress team={team} /></div>
      {!team.tasks.length ? <div className="teams-empty"><GitBranch size={28} /><h3>{c.noTasks}</h3><p>{c.noTasksHint}</p></div> : <div className="teams-board">{lanes.map(({ key, label, Icon }) => {
        const tasks = rows.filter(({ task }) => key === 'finished' ? ['done', 'cancelled'].includes(task.status) : task.status === key);
        return <div className="teams-lane" key={key}><h3><Icon size={16} /><span>{label}</span><small>{tasks.length}</small></h3>{!tasks.length && <p className="teams-lane-empty">{c.emptyLane}</p>}{tasks.map(({ task, depth }) => {
          const result = task.attempts.find(a => a.id === task.currentAttemptId)?.result;
          const assignee = team.bots.find(b => b.id === task.assigneeBotId);
          return <button className="teams-task-preview" id={`team-task-${task.id}`} key={task.id} onClick={() => onTask(task.id)}>
            {depth > 0 && <small className="teams-parent-label"><GitBranch size={12} />{team.tasks.find(t => t.id === task.parentTaskId)?.goal.split('\n')[0]}</small>}
            <strong>{task.goal}</strong><span className="teams-task-owner"><Bot size={14} />{assignee?.name ?? '—'}{task.status === 'cancelled' && <small>{c.cancelled}</small>}</span>
            {result && <span className="teams-result-preview">{result}</span>}
            {['pending', 'failed'].includes(task.cleanup) && <small className={task.cleanup === 'failed' ? 'teams-error' : ''}>{task.cleanup === 'failed' ? c.cleanupFailed : c.cleanupPending}</small>}
          </button>;
        })}</div>;
      })}</div>}
    </section>
  </>;
}

export function TeamListCard({ team, machine }: { team: TeamState; machine: string }) {
  const c = useWorkspaceCopy();
  return <Link className="teams-list-card" to={`/teams/${team.id}`}><div className="teams-section-heading"><h2><Bot size={24} />{team.name}</h2><ArrowUpRight size={18} /></div><p><Monitor size={14} />{machine}</p><div className="teams-roster">{team.bots.slice(0, 4).map(b => <span key={b.id}><Bot size={14} />{b.name}</span>)}{team.bots.length > 4 && <span>+{team.bots.length - 4}</span>}{!team.bots.length && <span>{c.noMembers}</span>}</div><TeamProgress team={team} />{team.tasks.filter(t => ['running', 'submitted'].includes(t.status)).slice(0, 2).map(t => <p className="teams-list-task" key={t.id}><span>{t.status === 'submitted' ? c.submitted : c.running}</span>{t.goal}</p>)}</Link>;
}
