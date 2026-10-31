/**
 * B-849b: what a Claude session really runs, read from Claude Code itself.
 *
 * `Query.getSettings()` (the `get_settings` control request; present at runtime
 * in the pinned SDK 0.3.306, missing from its .d.ts — hence the narrow
 * assertion) answers with
 *   - `effective.model`: the model settings.json pins, merged by Claude Code
 *     across user / project / local exactly as it applies them → the session's
 *     `configuredModel` (「本机配置」);
 *   - `applied.effort`: the effort the next request sends, after env, session
 *     state, org caps and model downgrades → `currentThoughtLevelCode`.
 * Probed 2026-10-31 (tmp/vh-team-B-849b/probe): settings.local.json
 * `claude-haiku-5-5` over user `opus[1m]` → effective.model haiku, applied
 * effort `medium` with no `effort` option, `xhigh` with it. system/init carries
 * no effort on this transport.
 *
 * The same probe showed `setModel(undefined)` lands on Claude Code's built-in
 * default (Fable 5.1), NOT the settings model a fresh Query starts on — so a
 * "machine default" switch mid-session must name the settings model itself.
 */
import { withTimeout } from './utils/withTimeout';

export type ClaudeRunFacts = {
    /** Effort the next request sends; null = none sent; undefined = unknown. */
    effort?: string | null;
    /** settings.json model (merged); null = none pinned; undefined = unknown. */
    configuredModel?: string | null;
};

type SettingsReader = { getSettings?: () => Promise<unknown> };

const GET_SETTINGS_TIMEOUT_MS = 3_000;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Pure parse of a `get_settings` response. */
export function parseClaudeRunFacts(raw: unknown): ClaudeRunFacts {
    const facts: ClaudeRunFacts = {};
    if (!raw || typeof raw !== 'object') return facts;
    const { applied, effective } = raw as { applied?: unknown; effective?: unknown };
    if (applied && typeof applied === 'object' && 'effort' in applied) {
        const effort = (applied as { effort?: unknown }).effort;
        if (effort === null) facts.effort = null;
        else if (typeof effort === 'string' && EFFORTS.has(effort)) facts.effort = effort;
    }
    if (effective && typeof effective === 'object') {
        const model = (effective as { model?: unknown }).model;
        facts.configuredModel = typeof model === 'string' && model.trim() ? model.trim() : null;
    }
    return facts;
}

/** Ask the live Query; null when this Claude Code cannot answer (never throws). */
export async function readClaudeRunFacts(query: unknown, timeoutMs = GET_SETTINGS_TIMEOUT_MS): Promise<ClaudeRunFacts | null> {
    const reader = query as SettingsReader;
    if (typeof reader?.getSettings !== 'function') return null;
    try {
        return parseClaudeRunFacts(await withTimeout(reader.getSettings(), timeoutMs, 'get_settings'));
    } catch {
        return null;
    }
}

/**
 * The `setModel` target for a mode model. An explicit model passes through;
 * "machine default" (undefined) resolves to the settings model, so the switch
 * lands where a fresh Query would start. Unknown settings → undefined (the old
 * behavior: Claude Code's built-in default).
 */
export async function liveModelTarget(query: unknown, model: string | undefined, timeoutMs = GET_SETTINGS_TIMEOUT_MS): Promise<string | undefined> {
    if (model) return model;
    const facts = await readClaudeRunFacts(query, timeoutMs);
    return facts?.configuredModel ?? undefined;
}
