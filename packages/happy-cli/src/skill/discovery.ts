/**
 * B-917: the only always-on line about Very Happy's own capabilities. It is
 * injected into every managed Claude system prompt, the first Codex turn and the
 * first ACP (pi / gemini) prompt, replacing the narrower B-575 todo line. Keep
 * it constant across releases (no version, date or machine data): any change
 * invalidates the prompt cache prefix of every new session. Pinned by test.
 */
export const VERY_HAPPY_DISCOVERY = 'To learn or operate Very Happy itself (sessions, terminals, projects, teams, automations, Issues and the user’s My todos, accounts, machines, sharing, notifications, settings), run `very-happy skill` for the capability map, then `very-happy skill <area>`; for My todos run `very-happy todo skill`. Do not confuse account todos with your execution plan; restricted team workers must not bypass their scope.';
