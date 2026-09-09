import { Link } from 'react-router-dom';
import { Bot, ChevronRight } from 'lucide-react';
import { useTeamNavigation } from '@/screens/sessions/useTeamNavigation';
import { teamSessionMembership } from '@/screens/sessions/teamNavigation';
import { useTeamNavigationCopy } from '@/screens/sessions/teamNavigationCopy';
import './sessionTeamContext.css';

/** Omit entirely for ordinary conversations. Never infers membership from names. */
export function SessionTeamContext({ sessionId }: { sessionId: string }) {
  const teams = useTeamNavigation();
  const copy = useTeamNavigationCopy();
  const membership = teamSessionMembership(teams).get(sessionId);
  if (!membership) return null;
  const { team, bot } = membership;
  return <nav className="session-team-context" aria-label={copy.progress}>
    <Link to={`/teams/${encodeURIComponent(team.id)}`}><Bot size={15} /><span>{team.name}</span></Link>
    <ChevronRight size={14} />
    <span>{bot.root ? copy.lead : bot.name || copy.member}</span>
    <Link className="session-team-context-progress" to={`/teams/${encodeURIComponent(team.id)}`}>{copy.progress}</Link>
  </nav>;
}
