/**
 * The service line a Claude `/compact` turn ends with.
 *
 * Claude Code reports a manual compaction's verdict in a `system/status`
 * frame (`compact_result: 'success' | 'failed'`, `compact_error`), not in the
 * turn's result: a refused compaction ("Not enough messages to compact.")
 * still ends with `result/success` and zero turns. Reading only the result
 * told the user 「上下文已压缩」 for a compaction that never happened.
 */
export type ClaudeCompactStatus = { result: string; error?: string };

/** The compaction verdict carried by a `system/status` frame, if any. */
export function readCompactStatus(message: unknown): ClaudeCompactStatus | null {
    if (!message || typeof message !== 'object') return null;
    const frame = message as { type?: unknown; subtype?: unknown; compact_result?: unknown; compact_error?: unknown };
    if (frame.type !== 'system' || frame.subtype !== 'status' || typeof frame.compact_result !== 'string') return null;
    return typeof frame.compact_error === 'string' && frame.compact_error.trim()
        ? { result: frame.compact_result, error: frame.compact_error.trim() }
        : { result: frame.compact_result };
}

/**
 * `Compaction completed` only when Claude said the compaction itself
 * succeeded (or, for a CLI without the status verdict, the turn did);
 * otherwise `Compaction failed: <Claude's reason>`.
 */
export function compactOutcomeEvent(
    result: { subtype: string; errors?: readonly string[] },
    status: ClaudeCompactStatus | null,
): string {
    if (result.subtype !== 'success') return `Compaction failed: ${result.errors?.join('\n') || result.subtype}`;
    if (status && status.result !== 'success') return `Compaction failed: ${status.error ?? status.result}`;
    return 'Compaction completed';
}
