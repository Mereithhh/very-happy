import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, UsersRound } from 'lucide-react';
import { AgentChip } from './AgentChip';
import { agentKindLabel, agentKindOf } from './agentIdentity';
import type { TeamBot, TeamState } from '@slopus/happy-wire';
import { useTeamNavigation } from '@/screens/sessions/useTeamNavigation';
import { teamSessionMembership } from '@/screens/sessions/teamNavigation';
import { useTeamNavigationCopy } from '@/screens/sessions/teamNavigationCopy';
import { LeadViewToggle } from './LeadView';
import './sessionTeamContext.css';

/** Omit entirely for ordinary conversations. Never infers membership from names. */
export function SessionTeamContext({ sessionId }: { sessionId: string }) {
  const teams = useTeamNavigation();
  const membership = teamSessionMembership(teams).get(sessionId);
  if (!membership) return null;
  // B-766: the lead's conversation offers 「全部消息 | 只看我和负责人」.
  return <SessionTeamContextView team={membership.team} bot={membership.bot} toggle={membership.bot.root ? <LeadViewToggle sessionId={sessionId} /> : undefined} />;
}

/** B-614: presentational half, fed fixtures by the dev harness. */
export function SessionTeamContextView({ team, bot, toggle }: { team: TeamState; bot: TeamBot; toggle?: ReactNode }) {
  const copy = useTeamNavigationCopy();
  return <nav className="session-team-context" aria-label={copy.progress}>
    {/* B-614: team = UsersRound (as in the sidebar), member = its agent glyph. */}
    <Link to={`/teams/${encodeURIComponent(team.id)}`}><UsersRound size={15} aria-hidden /><span>{team.name}</span></Link>
    <ChevronRight size={14} aria-hidden className="session-team-context-sep" />
    <AgentChip kind={agentKindOf(bot.assistant)} name={bot.root ? copy.lead : bot.name || copy.member} title={agentKindLabel(agentKindOf(bot.assistant)) ?? undefined} />
    <Link className="session-team-context-progress" to={`/teams/${encodeURIComponent(team.id)}`}>{copy.progress}</Link>
    {toggle}
  </nav>;
}
