/**
 * Live model switching for a running Claude SDK Query.
 *
 * Until 0.2.104 a model change was applied by KILLING the Claude Code process
 * and replaying the message into a fresh Query (the mode-hash relaunch path in
 * claudeRemoteLauncher). That cost a ~700ms respawn plus a transcript reload per
 * switch, and it made the switch depend on the fragile park-and-replay path —
 * which is exactly where the "switching the model does nothing" bug lived.
 *
 * `Query.setModel()` does it in place instead. Verified against the pinned SDK
 * on 2026-09-03 by driving a streaming-input Query and reading `result.modelUsage`
 * (the authoritative record, not the model's self-report):
 *   - turn 1 on `haiku` → modelUsage {claude-haiku-4-5}
 *   - setModel('sonnet') resolves → a FRESH system/init arrives carrying the new
 *     model, and turn 2 bills to claude-sonnet-5
 *   - setModel('definitely-not-a-model') REJECTS with 'Model "…" is not a
 *     recognized model id.' and the session keeps running on the previous model
 * That last case is why callers must catch: a stale client sending a dead alias
 * (the `fable5` shape) must surface an error, not kill the turn.
 *
 * Because init is re-emitted per turn with the model actually in force, the
 * metadata the web renders self-corrects on the next turn either way.
 */

/** Normalize a mode's model field to what {@link import('@anthropic-ai/claude-agent-sdk').Query.setModel} takes. */
export function modelTarget(model: string | null | undefined): string | undefined {
    return model == null || model === '' ? undefined : model;
}

/**
 * Whether moving from `current` to `next` needs a setModel call. `undefined`
 * and `null` both mean "the machine's own default", so they are one state.
 */
export function needsModelSwitch(
    current: string | null | undefined,
    next: string | null | undefined,
): boolean {
    return modelTarget(current) !== modelTarget(next);
}

/** User-facing note for a model switch the CLI could not apply. */
export function modelSwitchFailureNotice(model: string | null | undefined, error: unknown): string {
    const name = modelTarget(model) ?? 'default';
    const detail = error instanceof Error ? error.message : String(error);
    return `⚠️ Could not switch to model "${name}" — continuing with the previous model. ${detail}`;
}
