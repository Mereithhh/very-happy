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
    /** Flavor publishes the running model: Claude (system/init) and pi/ACP (pi-acp currentModelId, B-362/B-370). */
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

/**
 * Which option the model selector should show as selected.
 *
 * The selector value is client intent (`session.modelMode`), and a fresh session carries
 * the agent default — `'default'` for Claude and for ACP runners (pi, gemini, opencode)
 * which inherit the Claude defaults. ACP runners publish their own model list plus the
 * model actually in effect (`metadata.currentModelCode`, pi-acp reports e.g.
 * `llm-hub/claude-fable-5-1`), and `'default'` is not in that list. Falling straight back
 * to `options[0]` showed a pi session as running "nvidia/DeepSeek V4 Flash" while it was on
 * claude-fable-5-1 (B-362) — the one place on screen that must tell the truth lied. So:
 * explicit intent first, then the published running model, then the first option.
 */
export function selectDisplayedModelKey(input: {
    selectedKey: string | null | undefined;
    running: string | null | undefined;
    optionKeys: readonly string[];
}): string | undefined {
    const { selectedKey, running, optionKeys } = input;
    if (selectedKey && optionKeys.includes(selectedKey)) return selectedKey;
    if (running && optionKeys.includes(running)) return running;
    return optionKeys[0];
}
