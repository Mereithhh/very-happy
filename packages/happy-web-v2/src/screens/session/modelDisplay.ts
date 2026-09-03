import { compactResolvedModelCode } from '@/components/modelModeOptions';

/**
 * Honest subtitle for the model selector: which model the CLI says is ACTUALLY
 * running, as reported by Claude Code's per-turn `system/init` and republished
 * as `metadata.currentModelCode`.
 *
 * The selector's own value is pure client intent — it flips the instant you tap
 * it, whether or not the agent ever adopts it. That is what made the
 * "switching the model does nothing" bug (B-292) invisible: nothing on screen
 * ever disagreed with the user. This is the counterweight, and it is deliberately
 * NEUTRAL rather than a warning: alias→id resolution is Claude Code's business
 * (`opus` → `claude-opus-5`, `opusplan` and `best` resolve per turn), so we
 * report what is running instead of guessing whether it "matches".
 *
 * Suppressed when it would only repeat what is already on screen: the `default`
 * option's own label is already the resolved default model.
 */
export function deriveRunningModelSubtitle(input: {
    isClaude: boolean;
    selectedKey: string | null | undefined;
    /** metadata.currentModelCode — absent here until CLI 0.2.105, which is what first publishes it for Claude sessions. */
    running: string | null | undefined;
}): string | undefined {
    if (!input.isClaude) return undefined;
    if (!input.running) return undefined;
    if (!input.selectedKey || input.selectedKey === 'default') return undefined;
    return compactResolvedModelCode(input.running);
}
