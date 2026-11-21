/**
 * SessionArchivedBanner (B-265) — strip under the chat header of an ARCHIVED
 * session. Says so, offers the one action (restore in place), and narrates
 * the restore: spawning on the machine → waiting for it to come online →
 * done (the banner unmounts when the session is active again) or a reason.
 * Token discipline as MirrorBanner: bg ladder + --warn; no --accent (an
 * archived session is not live).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, Moon, RotateCcw, Unplug, UsersRound } from 'lucide-react';
import { teamOwnedOpenTasks, type TeamBot, type TeamState } from '@slopus/happy-wire';
import { useTeamNavigationSnapshot } from '@/screens/sessions/useTeamNavigation';
import { teamSessionMembership } from '@/screens/sessions/teamNavigation';
import { leadSessionRevivable, useLeadReviveCopy } from '@/screens/teams/leadRevive';
import { useSession } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { Spinner } from '@/ui';
import { isNeverRunOffline, restoreSession, useRestoreState, RESTORE_SLOW_SPAWN_MS, type RestoreReason } from '@/app/sessionRestore';
import { isHibernated } from '@/app/sessionHibernation';
import { offlineAutoRestartText, useOfflineAutoRestartFailure } from './useRestartBannerMode';
import './mirror.css';

type TKey = Parameters<ReturnType<typeof useTranslation>['t']>[0];
export function restoreReasonKey(reason: RestoreReason | undefined): TKey {
    return `restore.reason.${reason ?? 'unknown'}` as TKey;
}

/**
 * B-945: the team whose stopped lead this conversation was, when the owner can bring
 * that lead back (「接回负责人」). Restoring the old conversation cannot help: its
 * worktree was removed when the root task was accepted.
 */
export function revivableLeadTeam(teams: TeamState[], sessionId: string): { team: TeamState; bot: TeamBot } | null {
    const membership = teamSessionMembership(teams).get(sessionId);
    return membership && membership.team.archivedAt === undefined && leadSessionRevivable(membership.team, membership.bot) ? membership : null;
}

export function SessionArchivedBanner({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const reviveCopy = useLeadReviveCopy();
    const teams = useTeamNavigationSnapshot();
    const leadTeam = useMemo(() => revivableLeadTeam(teams, sessionId), [teams, sessionId]);
    const session = useSession(sessionId);
    const state = useRestoreState(sessionId);
    // B-852 / QA25 P2-2: an automatic update left it offline — say why.
    const autoFailure = useOfflineAutoRestartFailure(sessionId);
    const busy = state?.phase === 'spawning' || state?.phase === 'awaiting-online';
    // "machine not responding" hint after RESTORE_SLOW_SPAWN_MS in `spawning`.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (state?.phase !== 'spawning') return;
        const iv = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(iv);
    }, [state?.phase]);
    // B-587: a hibernated session is offline on purpose; waking it is the
    // same restore, narrated as one「正在唤醒…」state — also for the moment
    // between reactivation (stamp no longer applies) and the banner unmounting.
    const hibernatedNow = isHibernated(session);
    const wasHibernated = useRef(false);
    if (hibernatedNow) wasHibernated.current = true;
    else if (!busy) wasHibernated.current = false;
    if (!session) return null;
    const hibernated = hibernatedNow || (busy && wasHibernated.current);

    let text: string;
    if (hibernated && (state?.phase === 'spawning' || state?.phase === 'awaiting-online')) {
        text = state.phase === 'spawning' && now - state.startedAt >= RESTORE_SLOW_SPAWN_MS ? t('hibernation.wakingSlow') : t('hibernation.waking');
    } else if (state?.phase === 'spawning') {
        text = now - state.startedAt >= RESTORE_SLOW_SPAWN_MS ? t('restore.restoringSlow') : t('restore.restoring');
    } else if (state?.phase === 'awaiting-online') {
        text = t('restore.awaitingOnline');
    } else if (state?.phase === 'failed') {
        text = `${t('restore.failed')}: ${t(restoreReasonKey(state.reason))}${state.reason === 'unknown' && state.message ? ` (${state.message})` : ''}`;
    } else if (hibernated) {
        text = t('hibernation.notice');
    } else if (autoFailure && session.archivedAt == null) {
        text = offlineAutoRestartText(autoFailure, t);
    } else {
        // recoverability: archived vs merely-offline get different notices.
        text = session.archivedAt != null ? t('restore.archivedNotice') : isNeverRunOffline(session) ? t('restore.neverRanNotice') : t('restore.offlineNotice');
    }
    const offline = session.archivedAt == null;
    // B-945: a stopped lead with open tasks — explain and point at the team page's「接回负责人」.
    // The old conversation's restore stays offered until it fails for its removed directory.
    const missingCwd = state?.phase === 'failed' && state.reason === 'missing-cwd';
    if (leadTeam && !busy && !hibernated) text = reviveCopy.session(leadTeam.team.name, teamOwnedOpenTasks(leadTeam.team, leadTeam.bot.id).total);

    return (
        <div className="mrb" data-testid="session-archived-banner" data-hibernated={hibernated ? '' : undefined}>
            <div className={`mrb-note${state?.phase === 'failed' || (autoFailure && !hibernated && !busy) ? ' mrb-note--failed' : ''}`} role="status" data-auto-restart-failed={autoFailure ? '' : undefined}>
                {hibernated ? <Moon size={13} /> : offline ? <Unplug size={13} /> : <Archive size={13} />}
                <span className="mrb-note-text">{text}</span>
                {leadTeam && !busy && (
                    <Link className="mrb-term-btn mono" to={`/teams/${encodeURIComponent(leadTeam.team.id)}`} data-testid="session-lead-revive-link">
                        <UsersRound size={13} aria-hidden />
                        <span>{reviveCopy.sessionLink}</span>
                    </Link>
                )}
                {!(leadTeam && missingCwd) && <button
                    type="button"
                    className="mrb-term-btn mono"
                    onClick={() => void restoreSession(sessionId)}
                    disabled={busy}
                    aria-busy={busy}
                >
                    {busy ? <Spinner size={13} /> : <RotateCcw size={13} />}
                    <span>{state?.phase === 'failed' ? t('restore.retry') : hibernated ? t('hibernation.wake') : t('restore.restore')}</span>
                </button>}
            </div>
        </div>
    );
}
