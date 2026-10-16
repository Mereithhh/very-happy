import { Link } from 'react-router-dom';
import { ChevronRight, UsersRound } from 'lucide-react';
import { AgentChip } from './AgentChip';
import { agentKindLabel, agentKindOf } from './agentIdentity';
import type { TeamBot, TeamState } from '@slopus/happy-wire';
import { useTeamNavigation } from '@/screens/sessions/useTeamNavigation';
import { teamSessionMembership } from '@/screens/sessions/teamNavigation';
import { useTeamNavigationCopy } from '@/screens/sessions/teamNavigationCopy';
import './sessionTeamContext.css';

/** Omit entirely for ordinary conversations. Never infers membership from names. */
export function SessionTeamContext({ sessionId }: { sessionId: string }) {
  const teams = useTeamNavigation();
  const membership = teamSessionMembership(teams).get(sessionId);
  if (!membership) return null;
  return <SessionTeamContextView team={membership.team} bot={membership.bot} />;
}

/** B-614: presentational half, fed fixtures by the dev harness. */
export function SessionTeamContextView({ team, bot }: { team: TeamState; bot: TeamBot }) {
  const copy = useTeamNavigationCopy();
  return <nav className="session-team-context" aria-label={copy.progress}>
    {/* B-614: team = UsersRound (as in the sidebar), member = its agent glyph. */}
    <Link to={`/teams/${encodeURIComponent(team.id)}`}><UsersRound size={15} aria-hidden /><span>{team.name}</span></Link>
    <ChevronRight size={14} aria-hidden className="session-team-context-sep" />
    <AgentChip kind={agentKindOf(bot.assistant)} name={bot.root ? copy.lead : bot.name || copy.member} title={agentKindLabel(agentKindOf(bot.assistant)) ?? undefined} />
    <Link className="session-team-context-progress" to={`/teams/${encodeURIComponent(team.id)}`}>{copy.progress}</Link>
  </nav>;
}
