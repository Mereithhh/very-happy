/**
 * B-849b: what a Claude session really runs, read from Claude Code itself.
 *
 * `Query.getSettings()` (the `get_settings` control request; present at runtime
 * in the pinned SDK 0.3.306, 0.3.318 and 0.3.322, missing from their .d.ts — hence the narrow
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
 * default (Fable 5.1 on CC 2.1.30x; CC 2.1.322's `fable` alias is Fable 5.2,
 * B-907), NOT the settings model a fresh Query starts on — so a
 * "machine default" switch mid-session must name the settings model itself.
 */
import { configuredModelOf } from './claudeConfiguredModel';
import { withTimeout } from './utils/withTimeout';

export type ClaudeRunFacts = {
    /** Effort the next request sends; null = none sent; undefined = unknown. */
    effort?: string | null;
    /** Model the machine config pins (settings env.ANTHROPIC_MODEL > process
     *  ANTHROPIC_MODEL > merged settings.json model, B-883); null = none
     *  pinned; undefined = unknown. */
    configuredModel?: string | null;
    /** B-908: the window Claude Code measures the main model against
     *  (`get_context_usage` rawMaxTokens — what autocompact uses); undefined = unknown. */
    contextWindow?: number;
};

type SettingsReader = { getSettings?: () => Promise<unknown>; getContextUsage?: (opts?: { detail?: 'summary' | 'full' }) => Promise<unknown> };

const GET_SETTINGS_TIMEOUT_MS = 3_000;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Pure parse of a `get_settings` response. `processEnvModel`: the
 *  `ANTHROPIC_MODEL` Claude Code inherited (not in the response). */
export function parseClaudeRunFacts(raw: unknown, processEnvModel?: string | null): ClaudeRunFacts {
    const facts: ClaudeRunFacts = {};
    if (!raw || typeof raw !== 'object') return facts;
    const { applied, effective } = raw as { applied?: unknown; effective?: unknown };
    if (applied && typeof applied === 'object' && 'effort' in applied) {
        const effort = (applied as { effort?: unknown }).effort;
        if (effort === null) facts.effort = null;
        else if (typeof effort === 'string' && EFFORTS.has(effort)) facts.effort = effort;
    }
    if (effective && typeof effective === 'object') {
        facts.configuredModel = configuredModelOf(effective as { model?: unknown; env?: unknown }, processEnvModel);
    }
    return facts;
}

/**
 * B-908: the context window of a `get_context_usage` answer. Claude Code
 * decides it per model, not by the `[1m]` marker — probed 2026-11-11
 * (tmp/vh-team-B908/probe): on CC 2.1.322 the plain Opus 5.5 / Fable 5.1 /
 * Fable 5.2 / Sonnet 5 ids already measure against 1_000_000
 * (autocompactSource model-default), Haiku 4.5 against 200_000; on 2.1.318 an
 * unknown id (Fable 5.2) is 200_000 unless sent as `[1m]`. And system/init
 * reports the model without `[1m]`, so this is the only fact the web has.
 */
export function parseContextWindow(raw: unknown): number | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const value = (raw as { rawMaxTokens?: unknown; raw_max_tokens?: unknown }).rawMaxTokens ?? (raw as { raw_max_tokens?: unknown }).raw_max_tokens;
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Ask the live Query; null when this Claude Code cannot answer (never throws). */
export async function readClaudeRunFacts(query: unknown, timeoutMs = GET_SETTINGS_TIMEOUT_MS): Promise<ClaudeRunFacts | null> {
    const reader = query as SettingsReader;
    if (typeof reader?.getSettings !== 'function') return null;
    let facts: ClaudeRunFacts;
    try {
        // claudeRemote copies claudeEnvVars into process.env before spawning Claude Code.
        facts = parseClaudeRunFacts(await withTimeout(reader.getSettings(), timeoutMs, 'get_settings'), process.env.ANTHROPIC_MODEL);
    } catch {
        return null;
    }
    if (typeof reader.getContextUsage === 'function') {
        try {
            // 'summary': no token-count API calls, answers from local estimates.
            const window = parseContextWindow(await withTimeout(reader.getContextUsage({ detail: 'summary' }), timeoutMs, 'get_context_usage'));
            if (window !== undefined) facts.contextWindow = window;
        } catch {
            // Unknown window: leave the published one alone.
        }
    }
    return facts;
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
