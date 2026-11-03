import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { prependToMessage } from '@/projects/prompt';
import { writePrivateFileSync } from '@/utils/secureFiles';
import { detectTeamUserLanguage, teamLanguageReminder, type TeamUserLanguage } from './language';

/**
 * B-877b (QA49): a lead that left team mode did not know it had. Its team tools answered
 * "no team scope … call team_inspect again", so it told the user to wait until its "team
 * permissions" came back. The exit marker (`teams/exited/<sessionId>.json`, written by the
 * daemon on 「退出团队模式」 or when an archived team's lead is relaunched) now drives both
 * what every team tool says and a one-time note before the next user turn.
 */
export type TeamExitMarker = {
    teamId: string;
    /** Absent from markers written before B-877b. */
    teamName?: string;
    managed?: boolean;
    at?: number;
    /** The owner's language at exit (B-877 detection); null/absent = say it generically. */
    language?: TeamUserLanguage | null;
    /** `archived`: the team was archived while the lead was down, and a relaunch found it (B-730 path). */
    reason?: 'exit' | 'archived';
    /** Set once the one-time note went out; never sent again, across restarts. */
    noticeAt?: number;
};

const SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export function teamExitMarkerPath(home: string, sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error('Invalid session id');
    return join(home, 'teams', 'exited', `${sessionId}.json`);
}

export function readTeamExitMarker(home: string, sessionId: string | null | undefined): TeamExitMarker | null {
    if (!sessionId || !SESSION_ID.test(sessionId)) return null;
    try {
        const marker = JSON.parse(readFileSync(teamExitMarkerPath(home, sessionId), 'utf8')) as TeamExitMarker;
        return typeof marker?.teamId === 'string' ? marker : null;
    } catch { return null; }
}

const teamLabel = (marker: TeamExitMarker) => `"${(marker.teamName || marker.teamId).replace(/[\u0000-\u001f\u007f"]/g, ' ').slice(0, 128)}"`;

/** What every team tool answers in a session that left its team. Never suggests retrying. */
export function teamExitedMessage(marker: TeamExitMarker): string {
    return `Team ${teamLabel(marker)} is archived and this session has left team mode; it is an ordinary session now. This is final, not a temporary failure or a missing permission: do not retry team tools, inspect or delegate to that team, or ask the user to restore team access. Do what the user asks yourself, in this session. Start a new team (team_create) only if the user explicitly asks for one. ${teamLanguageReminder(marker.language ?? null)}`;
}

/** The one-time note before the first user turn after the exit. */
export function teamExitNoticeText(marker: TeamExitMarker, language: TeamUserLanguage | null): string {
    const how = marker.reason === 'archived' ? 'was archived while this session was stopped' : 'was archived when the user exited team mode';
    return `[Very Happy: team mode ended] Team ${teamLabel(marker)} ${how}. This session is now an ordinary session: its members were stopped and their unfinished tasks cancelled, and team tools no longer work here. Do not delegate to or inspect the team, and do not wait for or ask the user to restore team access. If the user asks about the team or to continue its work, say plainly that team mode has ended and carry on with the work yourself (or ask whether they want you to). ${teamLanguageReminder(language)}`;
}

/** The language of the turn itself; a short or code-only message falls back to the owner's at exit. */
function noticeLanguage(message: string, marker: TeamExitMarker): TeamUserLanguage | null {
    const detected = detectTeamUserLanguage(message);
    if (detected) return detected;
    return (message.match(/[A-Za-z]/g) ?? []).length >= 20 ? null : marker.language ?? null;
}

/**
 * Prepends the note once per exit marker. `noticeAt` is written before the turn is sent, so a
 * crash mid-turn or a restart never repeats it.
 */
export function createTeamExitNotice(deps: { sessionId: () => string | null | undefined; home?: string }) {
    const home = deps.home ?? configuration.happyHomeDir;
    return {
        decorate(message: string): string {
            const sid = deps.sessionId();
            const marker = readTeamExitMarker(home, sid);
            if (!marker || marker.noticeAt !== undefined) return message;
            try { writePrivateFileSync(teamExitMarkerPath(home, sid!), JSON.stringify({ ...marker, noticeAt: Date.now() })); }
            catch (error) { logger.debug(`[teams] exit notice not recorded, skipping it: ${String(error)}`); return message; }
            return prependToMessage(message, teamExitNoticeText(marker, noticeLanguage(message, marker)));
        },
    };
}
export type TeamExitNotice = ReturnType<typeof createTeamExitNotice>;
