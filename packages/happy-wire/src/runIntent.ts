import { z } from 'zod';

// B-849b: a session's model / thinking choice lives on the session, not on the
// device that made it (specs/2026-10-session-run-intent.md). The wrapper is the
// only writer: it records what this session was set to in
// `metadata.modelIntent` / `metadata.effortIntent`, from a message's meta or
// from the `session-run-intent` RPC a picker fires the moment it changes. Every
// device reads them; a device-local pick is only an optimistic value until the
// wrapper echoes it back.
//
// Vocabulary (both fields are plain strings, AGENTS #14 — an unknown value must
// never make zod drop a whole metadata object; readers whitelist):
//   modelIntent:  'latest' (follow latest) | 'default' (本机配置) | a model id
//   effortIntent: 'default' (自动) | a level ('low' … 'max', Codex 'minimal' …)
//   null    = this wrapper records intents but nothing was chosen yet
//   absent  = an older wrapper that records none

/** Wrapper records intents, answers the RPC below and restores them on resume. */
export const RUN_INTENT_CAPABILITY = 'session-run-intent-v1';
/**
 * Claude wrapper: `model: null` switches back to the model the machine's
 * settings.json pins (not Claude Code's built-in default), so 「本机配置」 can be
 * picked mid-session.
 */
export const CLAUDE_CONFIG_MODEL_CAPABILITY = 'claude-config-model-v1';
/** Session RPC: set this session's intent now (no message needed). */
export const RUN_INTENT_RPC = 'session-run-intent';

export const MODEL_INTENT_CONFIG = 'default';
export const EFFORT_INTENT_AUTO = 'default';

const MODEL_INTENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/\-[\]]{0,159}$/;
const EFFORT_INTENT_PATTERN = /^[a-z]{1,16}$/;

/** Whitelisted read of `metadata.modelIntent` (or a wire value). */
export function readModelIntent(value: unknown): string | null | undefined {
    if (value === null) return null;
    return typeof value === 'string' && MODEL_INTENT_PATTERN.test(value) ? value : undefined;
}

/** Whitelisted read of `metadata.effortIntent` (or a wire value). */
export function readEffortIntent(value: unknown): string | null | undefined {
    if (value === null) return null;
    return typeof value === 'string' && EFFORT_INTENT_PATTERN.test(value) ? value : undefined;
}

/** `session-run-intent` RPC params. Each pair is optional; `model`/`effort` null = machine default. */
export const RunIntentRequestSchema = z.object({
    modelIntent: z.string().max(160).optional(),
    model: z.string().max(160).nullable().optional(),
    effortIntent: z.string().max(16).optional(),
    effort: z.string().max(16).nullable().optional(),
});
export type RunIntentRequest = z.infer<typeof RunIntentRequestSchema>;

export type RunIntentResponse =
    | { ok: true; modelIntent: string | null; effortIntent: string | null }
    | { ok: false; error: string };

export type RunIntents = { modelIntent: string | null; effortIntent: string | null };

/**
 * The intents after a message meta / RPC payload. An explicit intent wins; a
 * payload carrying only `model` / `effort` (an older Web) still records what it
 * set — the model id it sent, or `default` for null — so the session's choice
 * is never left describing an older pick. Keys absent leave the intent as is.
 */
export function nextRunIntents(current: RunIntents, input: Record<string, unknown> | null | undefined): RunIntents {
    if (!input) return current;
    const next = { ...current };
    const modelIntent = readModelIntent(input.modelIntent);
    if (typeof modelIntent === 'string') {
        next.modelIntent = modelIntent;
    } else if (Object.prototype.hasOwnProperty.call(input, 'model')) {
        const model = input.model;
        if (model === null || model === '') next.modelIntent = MODEL_INTENT_CONFIG;
        else if (typeof readModelIntent(model) === 'string') next.modelIntent = model as string;
    }
    const effortIntent = readEffortIntent(input.effortIntent);
    if (typeof effortIntent === 'string') {
        next.effortIntent = effortIntent;
    } else if (Object.prototype.hasOwnProperty.call(input, 'effort')) {
        const effort = input.effort;
        if (effort === null || effort === '') next.effortIntent = EFFORT_INTENT_AUTO;
        else if (typeof readEffortIntent(effort) === 'string') next.effortIntent = effort as string;
    }
    return next;
}

/**
 * What a resumed wrapper keeps running (QA23b P2-1): the previous wrapper's
 * recorded effort, so a resume or abort never quietly drops back to the
 * wrapper's start level. `undefined` = nothing to restore; `null` = auto.
 * `fallbackLevel` is what an older previous wrapper reported running
 * (`currentThoughtLevelCode`) — Codex's honest stand-in when no intent exists.
 */
export function restoredEffort(metadata: { effortIntent?: unknown; currentThoughtLevelCode?: unknown } | null | undefined, opts: { useReportedLevel?: boolean } = {}): string | null | undefined {
    const intent = readEffortIntent(metadata?.effortIntent);
    if (intent === EFFORT_INTENT_AUTO) return null;
    if (typeof intent === 'string') return intent;
    if (opts.useReportedLevel) {
        const reported = readEffortIntent(metadata?.currentThoughtLevelCode);
        if (typeof reported === 'string' && reported !== EFFORT_INTENT_AUTO) return reported;
    }
    return undefined;
}

/**
 * The sticky model a resumed wrapper keeps applying: the explicit model the
 * previous wrapper reported (`stickyModel`), else the intent's fixed model.
 * `null` = machine default; `undefined` = nothing recorded. `latest` resolves on
 * the Web, so without a sticky model it restores nothing.
 */
export function restoredModel(metadata: { modelIntent?: unknown; stickyModel?: unknown } | null | undefined): string | null | undefined {
    if (typeof metadata?.stickyModel === 'string' && readModelIntent(metadata.stickyModel)) return metadata.stickyModel;
    const intent = readModelIntent(metadata?.modelIntent);
    if (intent === MODEL_INTENT_CONFIG) return null;
    if (typeof intent === 'string' && intent !== 'latest') return intent;
    if (metadata?.stickyModel === null && typeof intent === 'string') return null;
    return undefined;
}

/**
 * Web: this device's pick against the session's recorded intent. `base` is the
 * intent the device saw when its user picked. Rules (spec §3):
 *   - no recorded intent (older wrapper) → the local pick, as before;
 *   - nothing chosen yet (intent null) → a local pick is pending;
 *   - the wrapper echoed the pick → confirmed;
 *   - the intent moved since the pick (another device's choice reached the
 *     wrapper later) → the session's intent wins, the local pick is stale;
 *   - otherwise the local pick is pending (「下一条起」) and is what this device sends.
 */
export function reconcileRunPick(input: { local: string | null | undefined; base: string | null | undefined; intent: string | null | undefined }): { value: string | null | undefined; state: 'local' | 'session' | 'pending' | 'superseded' } {
    const { local, base, intent } = input;
    if (intent === undefined) return { value: local, state: 'local' };
    // Nothing recorded yet (a fresh wrapper, or one just upgraded): a local
    // pick — even one made before the upgrade — is simply not sent yet.
    if (intent === null) return local === null || local === undefined ? { value: null, state: 'session' } : { value: local, state: 'pending' };
    if (local === null || local === undefined) return { value: intent, state: 'session' };
    if (local === intent) return { value: intent, state: 'session' };
    if (base !== intent) return { value: intent, state: 'superseded' };
    return { value: local, state: 'pending' };
}
