import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { prependToMessage } from '@/projects/prompt';
import { ensurePrivateDirectorySync, writePrivateFileSync } from '@/utils/secureFiles';
import { readTeamExitMarker } from './exitNotice';
import { detectTeamUserLanguage, TEAM_LANGUAGE_RULE_HEADING, teamLanguageReminder, teamLanguageRule, TEAM_LANGUAGES, type TeamUserLanguage } from './language';

/**
 * B-877c: B-877 writes the language rule into the prompt a team session starts with, so a
 * session started before it never got one and keeps answering in English after the upgrade.
 * Such a session gets the rule once, in front of its next turn. The marker
 * (`teams/language/<sessionId>.json`) is written before that turn goes out, so a crash or a
 * restart never repeats it; a session whose own prompt already carries the rule only records that.
 */
const SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const ENVELOPE = '[Very Happy team message ';
const BOARD_LINE = /^\[Briefing board\].*\n?/gm;

export function teamLanguageMarkerPath(home: string, sessionId: string): string {
    return join(home, 'teams', 'language', `${sessionId}.json`);
}

/** An envelope's body is someone else's words; its footer names the owner's language. */
function backfillLanguage(message: string): TeamUserLanguage | null {
    if (message.includes(ENVELOPE)) return TEAM_LANGUAGES.find(language => message.includes(teamLanguageReminder(language))) ?? null;
    return detectTeamUserLanguage(message.replace(BOARD_LINE, ''));
}

export function createTeamLanguageBackfill(deps: { sessionId: () => string | null | undefined; home?: string; scopeFile?: (sessionId: string) => string }) {
    const home = deps.home ?? configuration.happyHomeDir;
    const scopeFile = deps.scopeFile ?? ((sid: string) => process.env.VH_TEAM_SCOPE_FILE || join(home, 'teams', 'scopes', `${sid}.json`));
    return {
        /** `source` is the message before other injections: their text says nothing about the user's language. */
        decorate(message: string, source: string): string {
            const sid = deps.sessionId();
            if (!sid || !SESSION_ID.test(sid)) return message;
            const marker = teamLanguageMarkerPath(home, sid);
            if (existsSync(marker) || !existsSync(scopeFile(sid)) || readTeamExitMarker(home, sid)) return message;
            const hasRule = source.includes(TEAM_LANGUAGE_RULE_HEADING);
            try {
                ensurePrivateDirectorySync(join(home, 'teams', 'language'));
                writePrivateFileSync(marker, JSON.stringify({ at: Date.now(), via: hasRule ? 'prompt' : 'backfill' }));
            } catch (error) {
                logger.debug(`[teams] language rule not recorded, skipping it: ${String(error)}`);
                return message;
            }
            return hasRule ? message : prependToMessage(message, teamLanguageRule(backfillLanguage(source)));
        },
    };
}
export type TeamLanguageBackfill = ReturnType<typeof createTeamLanguageBackfill>;
