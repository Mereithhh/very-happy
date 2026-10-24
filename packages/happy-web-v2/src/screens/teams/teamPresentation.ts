import type { TeamBot, TeamState, TeamTask } from '@slopus/happy-wire';
import { teamProtocolBody } from '@/screens/session/teamMessage';
import { capChars, plainMarkdownLines } from '@/utils/markdownPreview';
/**
 * B-746: a task goal / result as compact plain lines for every folded preview
 * (list card, board, member card, parent label, parent picker): the team
 * protocol header is stripped and no markdown syntax survives. Full views
 * keep the source text.
 */
export function teamTextPreviewLines(text: string): string[] {
  return plainMarkdownLines(teamProtocolBody(text));
}
/** B-746 (O8): a reader / tooltip title — 「kind · first plain line」, at most 60 characters. */
export function readerTitle(kind: string, text: string): string {
  const head = teamTextPreviewLines(text)[0];
  return capChars(head ? `${kind} · ${head}` : kind, 60);
}
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

/** B-614: who sent a team transport message to whom — authoritative records only. */
export function teamMessageRoute(team: TeamState, localId: string | null): { from: TeamBot | null; to: TeamBot | null } | undefined {
  if (!localId) return undefined;
  const bot = (id: string | null | undefined) => (id ? team.bots.find(b => b.id === id) ?? null : null);
  const op = team.operations.find(o => localId === `teams-initial-${o.id}`);
  if (op) return { from: bot(team.tasks.find(t => t.id === op.taskId)?.ownerBotId), to: bot(op.botId) };
  const message = team.messages.find(m => localId.startsWith(`teams-message-${m.id}-`) && /^\d+$/.test(localId.slice(`teams-message-${m.id}-`.length)));
  return message ? { from: bot(message.senderBotId), to: bot(message.recipientBotId) } : undefined;
}
/**
 * B-798 P2-5: a failed team read is not always "teams are off". The server
 * answers 404 `teams_disabled` for the switch and 404 `team_not_found` for a
 * missing / foreign id — only the former may say the feature is unavailable.
 * 403 and a bare 404 (no code: route missing on an older server) keep the
 * unavailable explanation.
 */
export function teamLoadFailure(status: number, code: string): 'unavailable' | 'notFound' | 'error' {
  if (status === 404 && code === 'team_not_found') return 'notFound';
  if (status === 403 || status === 404) return 'unavailable';
  return 'error';
}
/**
 * B-798 P2-4: the default team name when the name field is left blank. The
 * whole first goal line made the heading a paragraph. A first line of up to
 * 40 characters is kept; a longer one shortens to its first sentence, then its
 * first clause, then a 40-character cut with an ellipsis.
 */
export function teamNameFromGoal(goal: string): string {
  const MAX = 40;
  const fits = (s: string) => Array.from(s).length <= MAX;
  const line = goal.trim().split('\n')[0].trim();
  if (fits(line)) return line;
  const sentence = line.split(/(?<=[。！？!?；;])|(?<=\.)\s+/)[0].replace(/[。！？!?；;.]$/, '').trim();
  if (sentence && fits(sentence)) return sentence;
  const clause = line.split(/(?<=[，,：:])/)[0].replace(/[，,：:]$/, '').trim();
  if (Array.from(clause).length >= 8 && fits(clause)) return clause;
  return `${Array.from(line).slice(0, MAX - 1).join('').trimEnd()}…`;
}
