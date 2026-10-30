/**
 * Parsers for special commands that require dedicated remote session handling
 */

export interface CompactCommandResult {
    isCompact: boolean;
    originalMessage: string;
}

export interface ClearCommandResult {
    isClear: boolean;
}

export interface SpecialCommandResult {
    type: 'compact' | 'clear' | 'mcp' | 'skills' | null;
    originalMessage?: string;
}

/**
 * `/compact [instructions]` as the user typed it. Accepts what a phone IME
 * produces — a full-width slash (／), a full-width space, upper case, a
 * newline or CJK text right after the word — but only when the command opens
 * the message: "please /compact" and "/compactx" stay chat. The result is the
 * canonical `/compact` / `/compact <instructions>` the agent understands.
 */
const COMPACT_RE = /^[/\uFF0F]compact(?![A-Za-z0-9_:-])([\s\S]*)$/i;
const LEADING_SPACE_RE = /^[\s\u3000\uFEFF\u200B]+/;

export function parseCompact(message: string): CompactCommandResult {
    const match = message.replace(LEADING_SPACE_RE, '').match(COMPACT_RE);
    if (!match) {
        return {
            isCompact: false,
            originalMessage: message
        };
    }
    const instructions = match[1].replace(/\u3000/g, ' ').trim();
    return {
        isCompact: true,
        originalMessage: instructions ? `/compact ${instructions}` : '/compact'
    };
}

/** The canonical `/compact …` text, or null when the message is not a compact command. */
export function compactCommandText(message: string): string | null {
    const result = parseCompact(message);
    return result.isCompact ? result.originalMessage : null;
}

/**
 * Parse /clear command
 * Only matches exactly "/clear"
 */
export function parseClear(message: string): ClearCommandResult {
    const trimmed = message.trim();
    
    return {
        isClear: trimmed === '/clear'
    };
}

/**
 * Unified parser for special commands
 * Returns the type of command and original message if applicable
 */
export function parseSpecialCommand(message: string): SpecialCommandResult {
    const compactResult = parseCompact(message);
    if (compactResult.isCompact) {
        return {
            type: 'compact',
            originalMessage: compactResult.originalMessage
        };
    }
    
    const clearResult = parseClear(message);
    if (clearResult.isClear) {
        return {
            type: 'clear'
        };
    }
    
    const trimmed = message.trim().toLowerCase();
    if (trimmed === '/mcp') {
        return { type: 'mcp' };
    }
    if (trimmed === '/skills') {
        return { type: 'skills' };
    }

    return {
        type: null
    };
}

/**
 * What Very Happy answers when a session's agent has no compaction — instead
 * of passing `/compact` to the model, which then claims it cannot run it.
 */
export const COMPACT_UNSUPPORTED_NOTICE = 'This session type does not support /compact';
