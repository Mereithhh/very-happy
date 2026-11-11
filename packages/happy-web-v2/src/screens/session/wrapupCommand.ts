/**
 * B-915 composer commands. `/wrapup` (alias `/收尾`) runs the built-in 收尾
 * action; `/handoff` (alias `/交接`) opens the 交接给… dialog. Web commands,
 * like `/btw` (B-283): the literal text never reaches the agent. Pure.
 */
export const WRAPUP_COMMAND = 'wrapup';
export const HANDOFF_COMMAND = 'handoff';

const WRAPUP_RE = /^\/(?:wrapup|收尾)$/i;
const HANDOFF_RE = /^\/(?:handoff|交接)$/i;

/** Which built-in action the whole composer text asks for; null = send as usual (`/wrapupx`, `/wrapup now`). */
export function parseBuiltinActionCommand(text: string): 'wrapup' | 'handoff' | null {
    const value = text.trim();
    if (WRAPUP_RE.test(value)) return 'wrapup';
    if (HANDOFF_RE.test(value)) return 'handoff';
    return null;
}

/** A chat session the user owns can run them (a shared-with-me or terminal-mirror session cannot). */
export function canOfferBuiltinActions(session: { share?: unknown; archivedAt?: number | null; metadata?: { flavor?: string | null } | null } | null | undefined): boolean {
    if (!session || session.share || session.archivedAt != null) return false;
    return session.metadata?.flavor !== 'terminal-mirror';
}

/**
 * Composer suggestions for the two commands. The Chinese spellings join the
 * list only once the user types a non-ASCII query (`/收`), so `/` shows each
 * action once.
 */
export function builtinActionSuggestions(text: string, descriptions: { wrapup: string; handoff: string }): { command: string; description: string }[] {
    const items = [
        { command: WRAPUP_COMMAND, description: descriptions.wrapup },
        { command: HANDOFF_COMMAND, description: descriptions.handoff },
    ];
    const query = text.match(/^\/([^\s/]*)$/)?.[1] ?? '';
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7f]/.test(query)) items.push({ command: '收尾', description: descriptions.wrapup }, { command: '交接', description: descriptions.handoff });
    return items;
}
