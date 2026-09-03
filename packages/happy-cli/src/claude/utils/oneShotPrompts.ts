/**
 * Prompt prefixes of very-happy's own one-shot Claude invocations (B-290).
 *
 * `titleGenerator` and `boardAnalyzer` run `claude -p` against a real Claude
 * Code binary, so each call leaves a short persisted transcript in
 * `~/.claude/projects` next to the user's actual conversations — 84 of the 400
 * most recent transcripts on the author's machine were these. They are
 * machinery, not conversations: the import picker must not offer them.
 *
 * The constants live here (rather than inside those modules) so the history
 * scanner can match them without importing the spawn machinery; each owner
 * builds its prompt from the constant and a test pins that relationship, so
 * editing a prompt can't silently un-hide its transcripts.
 */
export const TITLE_PROMPT_PREFIX = 'Summarize the SPECIFIC topic/request of this message into a 3-6 word title';

export const BOARD_ANALYZER_PROMPT_PREFIX = 'You are a status analyzer for a task board of coding-agent sessions.';

export const VERY_HAPPY_ONE_SHOT_PROMPT_PREFIXES: readonly string[] = [
    TITLE_PROMPT_PREFIX,
    BOARD_ANALYZER_PROMPT_PREFIX,
];

/** True when a transcript's first user prompt is one of very-happy's own
 *  one-shot helper calls rather than something a person typed. */
export function isVeryHappyOneShotPrompt(firstPrompt: string): boolean {
    const text = firstPrompt.trimStart();
    return VERY_HAPPY_ONE_SHOT_PROMPT_PREFIXES.some((prefix) => text.startsWith(prefix));
}
