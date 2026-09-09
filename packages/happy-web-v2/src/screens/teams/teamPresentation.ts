import type { TeamBot, TeamState, TeamTask } from '@slopus/happy-wire';
export function teamRootTask(team: TeamState): TeamTask | undefined {
  return team.tasks.find(t => !t.parentTaskId && team.bots.some(b => b.root && b.managed && b.id === t.assigneeBotId));
}
export function memberTitle(bot: TeamBot, labels: {leadLabel:string; member:string}): string {
  if (bot.root) return labels.leadLabel;
  return /^(worker|member|bot)([-_\s]*\d+)?$/i.test(bot.name) ? labels.member : bot.name;
}
/** Bind transport IDs to authoritative records; never infer task status from prose. */
export function teamMessageTask(team: TeamState, localId: string | null): TeamTask | undefined {
  if (!localId) return undefined;
  const op = team.operations.find(o => localId === `teams-initial-${o.id}`);
  if (op) return team.tasks.find(t => t.id === op.taskId);
  const message = team.messages.find(m => localId.startsWith(`teams-message-${m.id}-`) && /^\d+$/.test(localId.slice(`teams-message-${m.id}-`.length)));
  return message?.taskId ? team.tasks.find(t => t.id === message.taskId) : undefined;
}

export function teamLaunchPhase(team: TeamState): 'empty' | 'preparing' | 'failed' | 'connected' | 'finished' | 'cancelled' {
  const task = teamRootTask(team);
  if (!task) return team.bots.length ? 'connected' : 'empty';
  if (task.status === 'done') return 'finished';
  if (task.status === 'cancelled') return 'cancelled';
  const bot = team.bots.find(b => b.id === task.assigneeBotId);
  if (bot?.sessionId) return 'connected';
  const launch = team.operations.find(o => o.type === 'spawn' && o.attemptId === task.currentAttemptId);
  return launch && ['pending', 'claimed'].includes(launch.status) ? 'preparing' : 'failed';
}
export function teamForMessage(teams: TeamState[], sessionId: string | undefined, localId: string | null): TeamState | undefined {
  if (!sessionId) return undefined;
  return teams.find(team => team.bots.some(b => b.sessionId === sessionId))
    ?? teams.find(team => team.operations.some(o => o.sessionId === sessionId) && !!teamMessageTask(team, localId));
}

/** Only a current, unfinished attempt can explain a startup failure. */
export function taskLaunchIssue(team: TeamState, task: TeamTask) {
  if (task.status !== 'queued') return undefined;
  return team.operations.find(op => op.type === 'spawn' && op.taskId === task.id && op.attemptId === task.currentAttemptId && ['failed', 'unknown'].includes(op.status));
}
