/**
 * B-515 phase 0: per-turn latency measurement for the Claude remote path.
 *
 * Pure formatting only — no content, no ids, just millisecond deltas between
 * wall-clock marks claudeRemote already passes through, plus the timing fields
 * Claude Code reports on its own result message (tolerated when absent).
 */

export type ClaudeTurnMarks = {
    /** Message entered the session queue (falls back to dequeue time). */
    pushedAt?: number;
    /** `query()` called — Claude Code process spawned. First turn only. */
    spawnAt?: number;
    /** Initialize handshake answered (`supportedModels()` resolved) — first turn only. */
    handshakeAt?: number;
    /** First `system/init` of this turn. */
    initAt?: number;
    /** First `assistant` message of this turn. */
    firstAssistantAt?: number;
};

const SDK_TIMING_FIELDS = ['ttft_ms', 'time_to_request_ms', 'time_to_request_from_spawn_ms'] as const;

function delta(from: number | undefined, to: number | undefined): string {
    if (typeof from !== 'number' || typeof to !== 'number' || to < from) return '-';
    return `${Math.round(to - from)}ms`;
}

function sdkField(result: unknown, key: string): string {
    if (!result || typeof result !== 'object') return '-';
    const value = (result as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}` : '-';
}

export function formatClaudeTimingLine(input: {
    turn: number;
    firstTurnOfProcess: boolean;
    marks: ClaudeTurnMarks;
    /** The SDK result message of this turn (only its numeric timing fields are read). */
    result?: unknown;
}): string {
    const m = input.marks;
    const sdk = SDK_TIMING_FIELDS.map((key) => `${key}=${sdkField(input.result, key)}`).join(',');
    return [
        '[CLAUDE TIMING]',
        `turn=${input.turn}`,
        `firstTurnOfProcess=${input.firstTurnOfProcess}`,
        `pushed→spawn=${delta(m.pushedAt, m.spawnAt)}`,
        `spawn→handshake=${delta(m.spawnAt, m.handshakeAt)}`,
        `handshake→init=${delta(m.handshakeAt, m.initAt)}`,
        `init→firstAssistant=${delta(m.initAt, m.firstAssistantAt)}`,
        `pushed→firstAssistant=${delta(m.pushedAt, m.firstAssistantAt)}`,
        `sdk{${sdk}}`,
    ].join(' ');
}
