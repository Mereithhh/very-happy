/**
 * B-844c (QA22b P2-A): the model a Codex turn runs.
 *
 * Codex app-server keeps a `turn/start` model as the thread's model for every
 * later turn that omits one, so "omit" never resets an earlier explicit pick —
 * a session sent gpt-6-luna kept running it after the web reset with
 * `model: null` (rollout: luna > luna > luna). A turn without an explicit
 * model therefore names the machine default (config/read's pinned model, else
 * model/list's isDefault) explicitly. Unknown default → omit, as before.
 */
export function resolveCodexTurnModel(
    requested: string | undefined,
    machineDefault: string | undefined,
): string | undefined {
    return requested || machineDefault || undefined;
}
