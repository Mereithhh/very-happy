/**
 * B-849b: which model / thinking this session is set to, on every device.
 *
 * The wrapper records the session's choice in `metadata.modelIntent` /
 * `metadata.effortIntent` (happy-wire runIntent.ts; spec
 * specs/2026-10-session-run-intent.md). That is the truth this module reads.
 * `session.modelMode` / `session.effortLevel` (device localStorage) are only a
 * pick this device made that the wrapper has not echoed yet.
 *
 * Rules:
 *   1. Recorded intent → that, on every device. The account default never
 *      overrides a session (it is for new sessions).
 *   2. A local pick the wrapper has not echoed → pending (「下一条起」), sent with
 *      the next message — unless another device's choice reached the wrapper
 *      after this pick: then the session's intent wins (last to reach the
 *      wrapper wins; `base` is the intent this device saw when it picked).
 *   3. No intent (older wrapper, or nothing chosen yet) and no local pick → what
 *      the session really runs (Claude `currentModelCode`; Codex its reported
 *      effort — its model keeps the B-844c follow-config rule); only a session
 *      that has not run yet takes the account default.
 */
import {
    EFFORT_INTENT_AUTO,
    isLatestModelMode,
    MODEL_INTENT_CONFIG,
    readEffortIntent,
    readModelIntent,
    reconcileRunPick,
    RUN_INTENT_CAPABILITY,
    RUN_INTENT_RPC,
    type RunIntentRequest,
    type RunIntentResponse,
} from '@slopus/happy-wire';
import { loadSessionRunPickBases, saveSessionRunPickBases, type RunPickBases } from './persistence';
import { normalizeAgentKey } from './agentDefaults';
import type { Session } from './storageTypes';

export type RunPickField = 'model' | 'effort';
export type RunPickState = 'local' | 'session' | 'pending' | 'superseded' | 'fallback' | 'none';
export type RunPick = { value: string | null | undefined; state: RunPickState };

type IntentMetadata = {
    capabilities?: readonly string[] | null;
    modelIntent?: string | null;
    effortIntent?: string | null;
    flavor?: string | null;
    currentModelCode?: string | null;
    stickyModel?: string | null;
    currentThoughtLevelCode?: string | null;
    models?: readonly { code: string; resolvedModel?: string | null; reasoningEfforts?: readonly string[] | null }[] | null;
} | null | undefined;
type PickSession = { id?: string; modelMode?: string | null; effortLevel?: string | null; metadata?: IntentMetadata };

export function recordsRunIntent(metadata: IntentMetadata): boolean {
    return metadata?.capabilities?.includes(RUN_INTENT_CAPABILITY) === true;
}

/**
 * B-849b2 (QA28 P2-4): whether the session's model can run `level`, judged by
 * the catalog its wrapper published. Unknown model / no catalog → no verdict
 * (true). `modelIntent` names the model when it is a fixed id; otherwise the
 * model the session runs.
 */
export function effortRunnable(metadata: IntentMetadata, level: string, modelIntent?: string | null): boolean {
    if (level === EFFORT_INTENT_AUTO) return true;
    const model = modelIntent && modelIntent !== MODEL_INTENT_CONFIG && !isLatestModelMode(modelIntent) ? modelIntent : metadata?.currentModelCode;
    if (!model) return true;
    const entry = metadata?.models?.find((option) => option.code === model || option.resolvedModel === model);
    if (!entry?.reasoningEfforts?.length) return true;
    return entry.reasoningEfforts.includes(level);
}

/** The session's recorded intents; undefined = an older wrapper (none recorded). */
export function sessionRunIntents(metadata: IntentMetadata): { model: string | null | undefined; effort: string | null | undefined } {
    if (!recordsRunIntent(metadata)) return { model: undefined, effort: undefined };
    // A new wrapper resumed over metadata an older one wrote: nothing recorded yet.
    const model = readModelIntent(metadata?.modelIntent) ?? null;
    const effort = readEffortIntent(metadata?.effortIntent) ?? null;
    // B-849b2 (QA28 P2-4): a level the session's model cannot run (recorded
    // from a refused message by a wrapper before the fix) is no choice at all.
    return { model, effort: effort !== null && !effortRunnable(metadata, effort, model) ? null : effort };
}

// --- bases (device-local, persisted) ---

let bases: RunPickBases | null = null;
const loadBases = () => (bases ??= loadSessionRunPickBases());
const BASE_KEY = { model: 'm', effort: 'e' } as const;

export function getRunPickBase(sessionId: string | undefined, field: RunPickField): string | null | undefined {
    if (!sessionId) return undefined;
    const entry = loadBases()[sessionId];
    return entry && Object.prototype.hasOwnProperty.call(entry, BASE_KEY[field]) ? entry[BASE_KEY[field]] : undefined;
}

export function setRunPickBase(sessionId: string, field: RunPickField, base: string | null | undefined): void {
    const all = { ...loadBases() };
    const entry = { ...(all[sessionId] ?? {}) };
    if (base === undefined) delete entry[BASE_KEY[field]];
    else entry[BASE_KEY[field]] = base;
    if (Object.keys(entry).length === 0) delete all[sessionId];
    else all[sessionId] = entry;
    bases = all;
    saveSessionRunPickBases(all);
}

/** Test seam. */
export function resetRunPickBasesForTests(next: RunPickBases | null = null): void {
    bases = next;
}

// --- resolution ---

function fallbackPick(field: RunPickField, metadata: IntentMetadata): string | undefined {
    const agent = normalizeAgentKey(metadata?.flavor);
    if (field === 'model') {
        // Codex keeps its B-844c rule: following the machine config resets a
        // sticky model, so no model fallback there.
        if (agent === 'claude' && metadata?.currentModelCode) return metadata.currentModelCode;
        return undefined;
    }
    if (agent === 'codex' && metadata?.currentThoughtLevelCode && effortRunnable(metadata, metadata.currentThoughtLevelCode)) return metadata.currentThoughtLevelCode;
    return undefined;
}

export function resolveRunPick(
    session: PickSession,
    field: RunPickField,
    baseOf: (sessionId: string | undefined, field: RunPickField) => string | null | undefined = getRunPickBase,
): RunPick {
    const local = field === 'model' ? session.modelMode : session.effortLevel;
    const intents = sessionRunIntents(session.metadata);
    const reconciled = reconcileRunPick({ local, base: baseOf(session.id, field), intent: intents[field] });
    if (reconciled.value !== null && reconciled.value !== undefined) return { value: reconciled.value, state: reconciled.state };
    const fallback = fallbackPick(field, session.metadata);
    if (fallback !== undefined) return { value: fallback, state: 'fallback' };
    return { value: undefined, state: 'none' };
}

/**
 * The session as every reader should see it: `modelMode` / `effortLevel`
 * replaced by the effective picks (undefined = take the new-session default).
 */
export function withRunPicks<T extends PickSession>(
    session: T,
    baseOf?: (sessionId: string | undefined, field: RunPickField) => string | null | undefined,
): T {
    const model = resolveRunPick(session, 'model', baseOf).value;
    const effort = resolveRunPick(session, 'effort', baseOf).value;
    if (model === session.modelMode && effort === session.effortLevel) return session;
    return { ...session, modelMode: model ?? null, effortLevel: effort ?? null };
}

/** An explicit 「自动」 pick (Claude / Codex draft) is stored as this key. */
export const EFFORT_PICK_AUTO = EFFORT_INTENT_AUTO;

/**
 * What to tidy after the wrapper answered: a pick it echoed is no longer a
 * local value, one another device superseded is dropped. Null = nothing to do.
 */
export function settledRunPick(session: PickSession, field: RunPickField): 'clear' | null {
    const local = field === 'model' ? session.modelMode : session.effortLevel;
    if (local === null || local === undefined) return null;
    const state = resolveRunPick(session, field).state;
    return state === 'session' || state === 'superseded' ? 'clear' : null;
}

export type RunIntentSender = (sessionId: string, method: string, params: RunIntentRequest) => Promise<unknown>;

/**
 * Push a pick to the wrapper now (no message needed), so every device shows it
 * and a meta-less send runs it. False when the wrapper cannot take it (older
 * CLI, offline, error) — the pick then stays pending and rides the next message.
 */
export async function pushRunIntent(session: PickSession & { id: string; presence?: Session['presence'] }, params: RunIntentRequest, send: RunIntentSender): Promise<boolean> {
    if (!recordsRunIntent(session.metadata) || session.presence !== 'online') return false;
    try {
        const raw = await send(session.id, RUN_INTENT_RPC, params) as RunIntentResponse | { error?: unknown } | null;
        // AGENTS #17: a resolved RPC can still be `{ error }`.
        return !!raw && typeof raw === 'object' && 'ok' in raw && raw.ok === true;
    } catch {
        return false;
    }
}
