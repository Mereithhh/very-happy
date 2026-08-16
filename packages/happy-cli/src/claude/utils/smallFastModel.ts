/**
 * Pin Claude Code's "small fast" background model to Haiku.
 *
 * Claude Code runs side LLM calls outside the main conversation loop — most
 * notably the built-in session title generation (`generate_session_title`,
 * the `ai-title` transcript entries), plus feedback titles and similar
 * utility work. The model for those calls resolves as:
 *
 *   ANTHROPIC_SMALL_FAST_MODEL (env) → provider/gate-dependent haiku default
 *   → otherwise the session's MAIN model.
 *
 * That last fallback means a session whose main model is opus burns opus
 * tokens on every ~5-word title (observed: ~22.7k prompt tokens per call on
 * integration-test probe sessions). Exporting ANTHROPIC_SMALL_FAST_MODEL to
 * every claude process Happy spawns makes the cheap path deterministic across
 * CLI versions and providers, without touching the main conversation model.
 *
 * An ANTHROPIC_SMALL_FAST_MODEL already present in the environment wins — we
 * only fill the default, never override an explicit user choice.
 */
export const SMALL_FAST_MODEL = 'claude-haiku-4-5-20251001'

export function pinSmallFastModel(env: Record<string, string | undefined>): void {
    if (!env.ANTHROPIC_SMALL_FAST_MODEL) {
        env.ANTHROPIC_SMALL_FAST_MODEL = SMALL_FAST_MODEL
    }
}
