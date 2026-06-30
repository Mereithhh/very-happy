/**
 * Thinking-block helpers.
 *
 * The reducer wraps agent "thinking" content in a single pair of `*...*` italic
 * markers (see sync/reducer/reducer.ts: `text: isThinking ? `*${c.thinking}*``).
 * Rendered straight through markdown that outer pair unbalances any inner
 * `**bold**`/`*em*` and leaks literal asterisks. Strip it before rendering —
 * mirrors v1 ThinkingBlock.
 */
export function stripThinkingWrapper(text: string): string {
    let t = (text ?? '').trim();
    if (t.startsWith('*') && t.endsWith('*') && t.length >= 2) {
        t = t.slice(1, -1).trim();
    }
    return t;
}

type Translate = (key: any, params?: any) => string;

/** "Thought for 12s" / "Thought for 1m 24s", or null when no positive duration. */
export function formatThoughtFor(durationMs: number | undefined, t: Translate): string | null {
    if (typeof durationMs !== 'number' || durationMs <= 0) return null;
    const seconds = Math.round(durationMs / 1000);
    if (seconds < 1) return null;
    const label =
        seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return t('session.chat.thoughtFor', { seconds: label });
}
