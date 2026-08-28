const INTERRUPT_SENTINEL = /^\[Request interrupted by user(?: for tool use)?\]$/i;
const EDE_DIAGNOSTIC_PREFIX = '[ede_diagnostic]';
const SDK_ERROR_PREFIX = 'Claude Code returned an error result:';

function errorEntries(value: string): string[] {
    return value.split(/[;\n]+/).map((entry) => entry.trim()).filter(Boolean);
}

function textBlocks(content: unknown): string[] | null {
    if (!Array.isArray(content) || content.length === 0) return null;

    const texts: string[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text') {
            return null;
        }
        const text = (block as { text?: unknown }).text;
        if (typeof text !== 'string') return null;
        texts.push(text.trim());
    }
    return texts;
}

/** Exact Claude Code synthetic user marker, never ordinary assistant output. */
export function isClaudeInterruptSentinelContent(content: unknown): boolean {
    if (typeof content === 'string') {
        return INTERRUPT_SENTINEL.test(content.trim());
    }
    const texts = textBlocks(content);
    return texts !== null && texts.length > 0 && texts.every((text) => INTERRUPT_SENTINEL.test(text));
}

function resultErrors(value: unknown): string[] {
    if (!value || typeof value !== 'object') return [];
    const errors = (value as { errors?: unknown }).errors;
    if (!Array.isArray(errors) || errors.length === 0 || errors.some((error) => typeof error !== 'string')) {
        return [];
    }
    return errors.map((error) => error.trim()).filter(Boolean);
}

/** Claude currently misclassifies some clean interrupts as an EDE-only error result. */
export function isClaudeEdeOnlyResult(value: unknown): boolean {
    const errors = resultErrors(value);
    return errors.length > 0 && errors.every((error) => error.startsWith(EDE_DIAGNOSTIC_PREFIX));
}

/**
 * Remove Claude Code's internal EDE entry while preserving any real error that
 * travelled beside it. Error fields are lifecycle metadata, never assistant
 * prose, so filtering the exact line prefix cannot hide user-authored text.
 */
export function stripClaudeEdeDiagnosticText(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (!trimmed.includes(EDE_DIAGNOSTIC_PREFIX)) return trimmed;

    const visible = errorEntries(trimmed)
        .filter((entry) => !entry.startsWith(EDE_DIAGNOSTIC_PREFIX));
    return visible.length > 0 ? visible.join('\n') : undefined;
}

/** Remove EDE entries from a result's user-visible error list. */
export function stripClaudeEdeDiagnosticErrors(value: unknown): string[] {
    return resultErrors({ errors: value })
        .filter((error) => !error.startsWith(EDE_DIAGNOSTIC_PREFIX));
}

/** Match only the SDK wrapper whose complete payload consists of EDE diagnostics. */
export function isClaudeEdeOnlySdkError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.trim();
    if (!message.startsWith(SDK_ERROR_PREFIX)) return false;

    const payload = message.slice(SDK_ERROR_PREFIX.length).trim();
    const entries = errorEntries(payload);
    return entries.length > 0 && entries.every((entry) => entry.startsWith(EDE_DIAGNOSTIC_PREFIX));
}
