/**
 * B-844c/B-844d: the model a Codex turn runs, and the model facts the wrapper
 * publishes.
 *
 * Codex app-server keeps a `turn/start` model as the thread's model for every
 * later turn that omits one, and keeps it across `thread/resume` (a restarted
 * wrapper) — so omitting `model` means "stay on the thread's model", which is
 * the `send` contract ("without --model the session keeps its model").
 *
 * Only an explicit reset (`meta.model === null`, the web following the
 * machine config) names the machine default (config/read's pinned model, else
 * model/list's isDefault): omitting would leave an earlier pick in force
 * (QA22b P2-A, rollout luna > luna > luna). Naming the default on every turn
 * without a model (B-844c) overrode the thread's model whenever the wrapper's
 * in-memory pick was lost — `send --resume`, an abort (QA23).
 */
export function resolveCodexTurnModel(
    mode: { model?: string; modelReset?: boolean },
    machineDefault: string | undefined,
): string | undefined {
    if (mode.model) return mode.model;
    return mode.modelReset ? machineDefault || undefined : undefined;
}

/**
 * What the wrapper publishes: `currentModelCode` = the model the thread runs;
 * `stickyModel` = a model it keeps that the machine config would not choose
 * (the web sends `model: null` to reset it while following the config), null
 * when it runs the machine default. Before a thread exists the pending
 * explicit pick stands in.
 */
export function codexModelFacts(input: {
    threadModel: string | null | undefined;
    pendingModel: string | undefined;
    machineDefault: string | undefined;
}): { stickyModel: string | null; currentModelCode?: string } {
    const { threadModel, pendingModel, machineDefault } = input;
    if (!threadModel) return { stickyModel: pendingModel ?? null };
    return {
        stickyModel: threadModel !== machineDefault ? threadModel : null,
        currentModelCode: threadModel,
    };
}
