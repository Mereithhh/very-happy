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
import { useMediaQuery } from '@/app/useMediaQuery';
import { useSessionBoard } from './board/useSessionBoard';
import './sessionTeamContext.css';

/** Omit entirely for ordinary conversations. Never infers membership from names. */
export function SessionTeamContext({ sessionId }: { sessionId: string }) {
  const teams = useTeamNavigation();
  const membership = teamSessionMembership(teams).get(sessionId);
  // D6: on phones with a 汇报板 the toggle lives in the board's summary strip (one row), not here.
  const phone = useMediaQuery('(max-width: 767px)');
  const hasBoard = useSessionBoard(sessionId);
  const inStrip = phone && hasBoard;
  if (!membership) return null;
  // B-766: the lead's conversation offers 「全部消息 | 只看我和负责人」.
  return <SessionTeamContextView team={membership.team} bot={membership.bot} toggle={membership.bot.root && !inStrip ? <LeadViewToggle sessionId={sessionId} /> : undefined} />;
}

/** B-766: the compact 「全部 | 只看我和负责人」 toggle for the phone summary strip — lead conversations only. */
export function LeadViewStripToggle({ sessionId }: { sessionId: string }) {
  const teams = useTeamNavigation();
  return teamSessionMembership(teams).get(sessionId)?.bot.root ? <LeadViewToggle sessionId={sessionId} compact /> : null;
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
