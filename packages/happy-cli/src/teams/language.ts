/**
 * B-877: team sessions drifted into English. A spawned lead's first turn is ~7 KB of English
 * team instructions around a ~100-character goal, and every later team turn arrives in an
 * English envelope, so the user's own words are a few percent of what the model reads as
 * "the user". This names the user's language explicitly, from the owner's own words.
 */
export type TeamUserLanguage = { name: string; code: 'zh' | 'ja' | 'ko' };

/** A path (`packages/happy-web-v2/src/…/ChatHeader.tsx`, `C:\\x\\y`): ASCII path characters around a separator. */
const PATH = /[\w.\-~@:…]*[\/\\][\w.\-~@:…\/\\]*/g;
/** A code identifier: camelCase / PascalCase humps, snake_case, dotted (`a.ts`, `obj.prop`) or letters mixed with digits. */
const IDENTIFIER = /\b[\w$]*(?:[a-z][A-Z]|_|\.[A-Za-z]|\d[A-Za-z]|[A-Za-z]\d)[\w$.]*\b/g;

/** The language of the owner's text, when it is clearly a CJK one; null means "say it generically". */
export function detectTeamUserLanguage(text: string | null | undefined): TeamUserLanguage | null {
    if (!text) return null;
    // B-877b (QA49 P2-4): paths and code identifiers are not words of the user's language.
    const stripped = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ')
        .replace(PATH, ' ').replace(IDENTIFIER, ' ');
    const kana = (stripped.match(/[぀-ヿ]/g) ?? []).length;
    const hangul = (stripped.match(/[가-힯]/g) ?? []).length;
    const han = (stripped.match(/[一-鿿]/g) ?? []).length;
    const latin = (stripped.match(/[A-Za-z]/g) ?? []).length;
    // A CJK character carries about one word; a Latin word is ~5 letters.
    const words = latin / 5;
    if (hangul >= 4 && hangul >= words) return { name: 'Korean (한국어)', code: 'ko' };
    // Chinese never uses kana: any kana in CJK text makes it Japanese (「調査して報告」 has two).
    if (kana >= 1 && kana + han >= 4 && kana + han >= words) return { name: 'Japanese (日本語)', code: 'ja' };
    if (han >= 4 && han >= words) return { name: 'Chinese (中文)', code: 'zh' };
    return null;
}

/** One paragraph placed right before the assigned goal of every team entry prompt. */
export function teamLanguageRule(language: TeamUserLanguage | null): string {
    const target = language ? language.name : 'the language the user wrote the goal in';
    return `## Language\nThe user works in ${target}. Write everything people read in ${language ? language.name : 'that language'}: replies, notes between tool calls, task goals, messages, submissions and reports. Think in it too. The team instructions, tool texts and message envelopes are English only for maintenance; never switch language because of them. Code, commands, identifiers and quoted text stay as they are.`;
}

/** Short reminder appended to each team message envelope. */
export function teamLanguageReminder(language: TeamUserLanguage | null): string {
    return language ? `Reply in ${language.name}, the user's language.` : 'Reply in the user\'s language, not this envelope\'s.';
}

/** The owner's own words in a team: a task the owner (not a bot) created. */
export function teamOwnerText(tasks: ReadonlyArray<{ goal: string; ownerBotId: string | null }> | undefined): string | null {
    return tasks?.find(task => task.ownerBotId === null)?.goal ?? null;
}
