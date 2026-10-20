/**
 * B-634 ③: a model the provider has retired (approach from Orca,
 * src/main/claude/claude-structured-retired-model.ts, MIT; rewritten).
 *
 * The web sends its picked model with every message and the wrapper hands it
 * to Claude Code unchecked (`--model` / `set_model`). One that no longer
 * exists fails every turn, and Claude Code says so itself: a synthetic root
 * assistant reply whose `error` is `model_not_found`. That reply is the
 * evidence; the session then stops holding the id — the live Query is put
 * back on the account default (`set_model` with no model) and later messages
 * that still carry the retired id run on the default too, instead of
 * failing again. The user's pick stays theirs to change; a notice says why.
 */
import { modelTarget } from './claudeLiveModel';

export const CLAUDE_MODEL_NOT_FOUND = 'model_not_found';

/** The running model when this frame says it does not exist (root reply only), else null. */
export function retiredModelFrom(message: unknown, runningModel: string | null | undefined): string | null {
    const m = message as { type?: unknown; error?: unknown; parent_tool_use_id?: unknown } | null;
    if (!m || m.type !== 'assistant' || m.error !== CLAUDE_MODEL_NOT_FOUND) return null;
    // A sub-agent's own model is not the session's pick.
    if ((m.parent_tool_use_id ?? null) !== null) return null;
    return modelTarget(runningModel) ?? null;
}

export type RetiredModels = {
    retire(model: string): void;
    /** The model to actually run for a requested one: undefined (the default) once it was retired. */
    effective(model: string | null | undefined): string | undefined;
};

/** Session-scoped: survives relaunches, so a fresh Query never starts on a retired id. */
export function createRetiredModels(): RetiredModels {
    const retired = new Set<string>();
    return {
        retire(model) { retired.add(model); },
        effective(model) {
            const target = modelTarget(model);
            return target !== undefined && retired.has(target) ? undefined : target;
        },
    };
}

export function retiredModelNotice(model: string): string {
    return `⚠️ Model "${model}" is no longer available — switched this session to the default model. Pick another model to change it, then send your message again.`;
}
