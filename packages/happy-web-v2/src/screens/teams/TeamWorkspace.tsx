import { teamBotActivity, teamCleanupIssues, type TeamBot, type TeamState, type TeamTask } from '@slopus/happy-wire';
import React from 'react';
import { Link } from 'react-router-dom';
import { Circle, UsersRound, CircleCheck, CircleDashed, Clock3, ArrowUpRight, GitBranch, Monitor, Archive, Info, Bot } from 'lucide-react';
import { Summary } from '@/ui/Summary';
import { useWorkspaceCopy } from './workspaceCopy';
import { t as tr } from '@/text';
import { useFirstUseCopy } from './firstUseCopy';
import { memberTitle, teamRootTask, taskLaunchIssue, teamTextPreviewLines } from './teamPresentation';
import { Markdown } from '@/screens/session/Markdown';
import { useOperationErrorSummary } from './OperationError';
import { FINISHED_PAGE_SIZE, finishedTasksByRecency, taskRows, teamFinishedGroupId } from './teamView';
import { botHistorySessionId, teamHasOnlyLead, teamInactiveGroupId, teamLeadSessionId, teamMemberCount, teamMemberInactive, teamRoster } from '@/screens/sessions/teamNavigation';
import { isGroupCollapsed, setGroupCollapsed, useCollapsedGroups } from '@/screens/sessions/sidebarCollapsedGroups';
import { useTeamNavigationCopy } from '@/screens/sessions/teamNavigationCopy';
import { AgentGlyph } from '@/screens/session/AgentChip';
import { teamTaskLane, teamTaskState, type MemberExecution, type TeamTaskState } from './teamTaskState';
import { useMemberExecution } from './useMemberExecution';
import { TeamTaskStatePill, teamTaskStateLabel } from './TeamTaskStatePill';
import { agentKindLabel, agentKindOf } from '@/screens/session/agentIdentity';

export function TeamProgress({ team }: { team: TeamState }) {
  const c = useWorkspaceCopy();
  const done = team.tasks.filter(t => t.status === 'done').length;
  return <div className="teams-progress"><progress aria-label={c.progress} max={Math.max(1, team.tasks.length)} value={done} /><span>{done}/{team.tasks.length} {c.progress}</span></div>;
}

/** B-761: every task's derived state (`teamTaskState`) from its member session's
 *  live execution; `execution` overrides the store reader (tests, the dev harness). */
export function useTeamTaskStates(team: TeamState, execution?: MemberExecution): (task: TeamTask) => TeamTaskState {
  const live = useMemberExecution();
  const read = execution ?? live;
  return (task: TeamTask) => teamTaskState(team, task, read);
}

/** `archivedSessionIds`: member conversations that are archived (B-690 inactive rule input). */
export function TeamWorkspace({ team, onTask, archivedSessionIds, now = Date.now(), execution }: { team: TeamState; onTask: (id: string) => void; archivedSessionIds?: ReadonlySet<string>; now?: number; execution?: MemberExecution }) {
  const c = useWorkspaceCopy();
  const stateOf = useTeamTaskStates(team, execution);
  const f = useFirstUseCopy();
  const operationError = useOperationErrorSummary();
  const rootTask = teamRootTask(team);
  const rows = taskRows(team.tasks);
  const rootResult = rootTask?.attempts.find(a => a.id === rootTask.currentAttemptId)?.result;
  const lanes = [
    { key: 'queued', label: c.queued, Icon: CircleDashed },
    { key: 'running', label: c.running, Icon: Clock3 },
    { key: 'submitted', label: c.submitted, Icon: Circle },
  ];
  const preview = (task: TeamTask, depth: number) => {
    const result = task.attempts.find(a => a.id === task.currentAttemptId)?.result;
    const assignee = team.bots.find(b => b.id === task.assigneeBotId);
    const state = stateOf(task);
    return <button className="teams-task-preview" id={`team-task-${task.id}`} key={task.id} data-state={state} onClick={() => onTask(task.id)}>
      {depth > 0 && <small className="teams-parent-label"><GitBranch size={12} />{teamTextPreviewLines(team.tasks.find(t => t.id === task.parentTaskId)?.goal ?? '')[0]}</small>}
      <strong className="teams-task-goal">{teamTextPreviewLines(task.goal).join('\n')}</strong><span className="teams-task-owner">{assignee && <AgentGlyph kind={agentKindOf(assignee.assistant)} />}{assignee ? memberTitle(assignee, f) : '—'}<TeamTaskStatePill state={state} /></span>
      {taskLaunchIssue(team, task) && <span className="teams-error">{f.launchFailed} · {operationError(taskLaunchIssue(team, task)?.error)}</span>}
      {result && <span className="teams-result-preview">{teamTextPreviewLines(result).join('\n')}</span>}
      {['pending', 'failed'].includes(task.cleanup) && <small className={task.cleanup === 'failed' ? 'teams-error' : ''}>{task.cleanup === 'failed' ? c.cleanupFailed : c.cleanupPending}</small>}
    </button>;
  };
  return <>
    {rootTask && <section className="team-goal"><div className="teams-section-heading"><h2>{f.goalTitle}</h2><TeamTaskStatePill state={stateOf(rootTask)} /></div><p>{rootTask.goal}</p><button onClick={() => onTask(rootTask.id)}>{f.inspect} →</button></section>}
    {rootResult && <section className="team-delivery"><h2><CircleCheck size={20} />{f.result}</h2><Markdown text={rootResult} /><button onClick={() => onTask(rootTask!.id)}>{f.inspect} →</button></section>}
    <TeamMembers team={team} archivedSessionIds={archivedSessionIds} now={now} execution={execution} />
    <section className="teams-work"><div className="teams-section-heading"><h2>{c.overview}</h2><TeamProgress team={team} /></div>
      {!team.tasks.length ? <div className="teams-empty"><GitBranch size={28} /><h3>{c.noTasks}</h3><p>{c.noTasksHint}</p></div> : <div className="teams-board">{lanes.map(({ key, label, Icon }) => {
        const tasks = rows.filter(({ task }) => teamTaskLane(stateOf(task)) === key);
        return <div className="teams-lane" key={key}><h3><Icon size={16} /><span>{label}</span><small>{tasks.length}</small></h3>{!tasks.length && <p className="teams-lane-empty">{c.emptyLane}</p>}{tasks.map(({ task, depth }) => preview(task, depth))}</div>;
      })}<FinishedLane team={team} preview={preview} /></div>}
    </section>
  </>;
}

/**
 * B-753: the 「已结束」 lane (done + cancelled) folds into one 「已结束 N 个」
 * row by default — a long-lived team piles up finished work that buries the
 * live lanes, worst on a phone where the lanes stack. The choice is per team
 * and device-local (sidebarCollapsedGroups, `team-finished:<id>`); open, it
 * shows the most recent FINISHED_PAGE_SIZE tasks and 「显示更多」 adds as many
 * again. Cards mount only while open, so hundreds of finished tasks cost no DOM.
 */
function FinishedLane({ team, preview }: { team: TeamState; preview: (task: TeamTask, depth: number) => React.ReactNode }) {
  const c = useWorkspaceCopy();
  const foldKey = teamFinishedGroupId(team.id);
  const open = !isGroupCollapsed(useCollapsedGroups(), foldKey);
  const [page, setPage] = React.useState({ teamId: team.id, limit: FINISHED_PAGE_SIZE });
  const limit = page.teamId === team.id ? page.limit : FINISHED_PAGE_SIZE;
  const tasks = finishedTasksByRecency(team);
  if (!tasks.length) return <div className="teams-lane"><h3><CircleCheck size={16} /><span>{c.finished}</span><small>0</small></h3><p className="teams-lane-empty">{c.emptyLane}</p></div>;
  const remaining = tasks.length - limit;
  return <details className="teams-lane teams-lane-finished" open={open} onToggle={(e) => {
    if (e.currentTarget.open === open) return;
    setGroupCollapsed(foldKey, !e.currentTarget.open);
    if (!e.currentTarget.open) setPage({ teamId: team.id, limit: FINISHED_PAGE_SIZE });
  }}>
    <Summary title={open ? c.hideFinished : c.showFinished}><CircleCheck size={16} aria-hidden /><span>{c.finishedCount(tasks.length)}</span></Summary>
    {open && <>
      {tasks.slice(0, limit).map(task => preview(task, team.tasks.some(t => t.id === task.parentTaskId) ? 1 : 0))}
      {remaining > 0 && <button type="button" className="teams-lane-more" onClick={() => setPage({ teamId: team.id, limit: limit + FINISHED_PAGE_SIZE })}>{c.showMore(remaining)}</button>}
    </>}
  </details>;
}

/**
 * B-690: members nothing is waiting on (`teamMemberInactive`) fold behind one
 * 「已停用 N 个」 disclosure — the sidebar's rule and its device-local choice
 * (`team-archived:<id>`). Folded members keep their history links, and the
 * handoff / new-task forms still offer them, so they can be reassigned.
 * B-759: the ⓘ explains who does what, and a team with only its lead says the
 * lead creates members, with a way into the lead's conversation.
 */
export function TeamMembers({ team, archivedSessionIds, now, execution }: { team: TeamState; archivedSessionIds?: ReadonlySet<string>; now: number; execution?: MemberExecution }) {
  const c = useWorkspaceCopy();
  const stateOf = useTeamTaskStates(team, execution);
  const f = useFirstUseCopy();
  const navCopy = useTeamNavigationCopy();
  const [rolesOpen, setRolesOpen] = React.useState(false);
  const rolesId = React.useId();
  const leadSessionId = teamLeadSessionId(team);
  const foldKey = teamInactiveGroupId(team.id);
  const inactiveOpen = !isGroupCollapsed(useCollapsedGroups(), foldKey);
  const context = { now, sessionArchived: (sessionId: string) => !!archivedSessionIds?.has(sessionId) };
  const inactive = team.bots.filter(bot => teamMemberInactive(team, bot, context));
  const current = team.bots.filter(bot => !inactive.includes(bot));
  const card = (bot: TeamBot) => {
    const historySessionId = botHistorySessionId(team, bot);
    const active = team.tasks.filter(t => t.assigneeBotId === bot.id && !['done', 'cancelled'].includes(t.status));
    const content = <><span className="teams-avatar" data-live={active.some(t => stateOf(t) === 'working')}><AgentGlyph kind={agentKindOf(bot.assistant)} size={18} /></span><span className="teams-member-info"><strong>{memberTitle(bot, f)}</strong><small>{agentKindLabel(agentKindOf(bot.assistant)) ?? bot.assistant}</small><span>{active[0] ? teamTextPreviewLines(active[0].goal).join(' ') : c.idle}</span>{!bot.sessionId && <small>{team.operations.some(o => o.botId === bot.id && ["unknown", "failed"].includes(o.status)) ? f.unknown : active.length ? teamTaskStateLabel(stateOf(active[0])) : f.stopped}</small>}{teamBotActivity(team, bot, context) === 'stopping' && <small className="teams-error">{navCopy.stopping}</small>}{/* B-775: also while a queued task makes the member "active" */}{teamCleanupIssues(team).some(issue => issue.botId === bot.id && issue.holdsSession) && <small className="teams-error">{c.cleanupHoldsMember}</small>}{bot.lastEvent && <small>{c.lastEvent} · {tr(`teams.${bot.lastEvent}`)}{bot.lastEventAt ? ` · ${new Date(bot.lastEventAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}` : ''}</small>}</span>{historySessionId && <ArrowUpRight size={16} aria-hidden />}</>;
    return historySessionId ? <Link key={bot.id} className="teams-member" to={`/session/${encodeURIComponent(historySessionId)}`}>{content}</Link> : <div key={bot.id} className="teams-member">{content}</div>;
  };
  return <section className="teams-members"><h2>{f.membersTitle} <small>{teamMemberCount(team, context)}</small>
    <button type="button" className="teams-roles-info" aria-expanded={rolesOpen} aria-controls={rolesId} aria-label={c.rolesInfo} title={c.rolesInfo} onClick={() => setRolesOpen(open => !open)}><Info size={15} aria-hidden /></button></h2>
    {rolesOpen && <p id={rolesId} className="teams-roles">{c.roles}</p>}
    {team.bots.length === 0 && <p>{c.noMembers}</p>}
    {teamHasOnlyLead(team) && <div className="teams-members-empty"><p>{c.membersByLead}</p>{leadSessionId && <Link className="teams-members-empty-cta" to={`/session/${encodeURIComponent(leadSessionId)}`}><Bot size={16} aria-hidden />{navCopy.openLead}</Link>}</div>}
    {current.length > 0 && <div className="teams-members-grid">{current.map(card)}</div>}
    {inactive.length > 0 && <details className="teams-members-inactive" open={inactiveOpen} onToggle={(e) => { if (e.currentTarget.open !== inactiveOpen) setGroupCollapsed(foldKey, !e.currentTarget.open); }}>
      <Summary title={inactiveOpen ? navCopy.hideInactive : navCopy.showInactive}><Archive size={14} aria-hidden />{navCopy.inactiveCount(inactive.length)}</Summary>
      <p className="teams-members-inactive-hint">{navCopy.inactiveHint}</p>
      <div className="teams-members-grid">{inactive.map(card)}</div>
    </details>}
  </section>;
}

/** B-723 (D1): the list card shows only current members (happy-wire's
 *  `teamBotActivity`, same rule as the sidebar and the Teams page); inactive
 *  ones collapse into one 「已停用 N 个」 chip. */
export function TeamListCard({ team, machine, archivedSessionIds, now = Date.now(), execution }: { team: TeamState; machine: string; archivedSessionIds?: ReadonlySet<string>; now?: number; execution?: MemberExecution }) {
  const c = useWorkspaceCopy();
  const stateOf = useTeamTaskStates(team, execution);
  const f = useFirstUseCopy();
  const navCopy = useTeamNavigationCopy();
  const { members, inactive } = teamRoster(team, { now, sessionArchived: (sessionId: string) => !!archivedSessionIds?.has(sessionId) });
  return <Link className="teams-list-card" to={`/teams/${team.id}`}><div className="teams-section-heading"><h2><UsersRound size={22} aria-hidden />{team.name}</h2><ArrowUpRight size={18} /></div><p><Monitor size={14} />{machine}</p><div className="teams-roster">{members.slice(0, 4).map(b => <span key={b.id} title={agentKindLabel(agentKindOf(b.assistant)) ?? undefined}><AgentGlyph kind={agentKindOf(b.assistant)} />{memberTitle(b, f)}</span>)}{members.length > 4 && <span>+{members.length - 4}</span>}{inactive > 0 && <span className="teams-roster-inactive"><Archive size={12} aria-hidden />{navCopy.inactiveCount(inactive)}</span>}{!team.bots.length && <span>{c.noMembers}</span>}</div><TeamProgress team={team} />{team.tasks.filter(t => ['running', 'submitted'].includes(t.status)).slice(0, 2).map(t => <p className="teams-list-task" key={t.id}><TeamTaskStatePill state={stateOf(t)} />{teamTextPreviewLines(t.goal).join(' ')}</p>)}</Link>;
}
