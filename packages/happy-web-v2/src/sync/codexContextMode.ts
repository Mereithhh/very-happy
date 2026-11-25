import {
    CODEX_CONTEXT_DEFAULT_MODE,
    codexContextWindowsOf,
    readCodexContextMode,
    readCodexContextWindows,
    reconcileRunPick,
    type CodexContextMode,
} from '@slopus/happy-wire';
import { normalizeAgentKey } from './agentDefaults';

/**
 * B-977: the Codex 「上下文」 picker data. The wrapper publishes, per model,
 * the window each mode runs (`metadata.codexContextWindows` — only models that
 * can run larger than standard) and the mode the session runs
 * (`metadata.codexContextMode`). A model outside that map has one window:
 * Codex's own default, and no picker.
 */

type ContextMetadata = {
    flavor?: string | null;
    codexContextMode?: string | null;
    codexThreadId?: string | null;
    codexContextWindows?: unknown;
    currentModelCode?: string | null;
    /** Settings: the model this machine's own config pins / Codex would run. */
    configuredModel?: string | null;
    defaultModelCode?: string | null;
} | null | undefined;

export type CodexContextOption = { key: CodexContextMode; window: number };

/**
 * B-977d: the model a Codex session's next turn runs, for the 「上下文」 row:
 * an explicit pick, else what it ran last, else (no turn yet) the model the
 * machine config / Codex would start it on. Without that last step a session
 * that never ran had no row and sent no `codexContext`, so a pick or the
 * account default could not reach its first turn.
 */
export function codexContextModelOf(metadata: ContextMetadata, modelKey: string | null | undefined): string | null | undefined {
    if (modelKey && modelKey !== 'default') return modelKey;
    return metadata?.currentModelCode ?? metadata?.configuredModel ?? metadata?.defaultModelCode;
}

/** A model's two windows, or null when the machine cannot tell / the model cannot run larger. */
export function contextWindowsForModel(metadata: ContextMetadata, model: string | null | undefined): { standard: number; extended: number } | null {
    if (normalizeAgentKey(metadata?.flavor) !== 'codex' || !model) return null;
    return readCodexContextWindows(metadata?.codexContextWindows)[model] ?? null;
}

export function supportsCodexContextChoice(metadata: ContextMetadata, model: string | null | undefined): boolean {
    return contextWindowsForModel(metadata, model) !== null;
}

/**
 * B-977d: the wrapper's report read as the session's recorded choice (like
 * `modelIntent` / `effortIntent`, sync/runPicks.ts). undefined = an older
 * wrapper (no report); null = nothing chosen yet — a wrapper reports the
 * product default at birth, before any turn ran (no thread, no running model),
 * and that must not stand in for a local pick or the account default.
 */
export function reportedCodexContextIntent(metadata: ContextMetadata): CodexContextMode | null | undefined {
    const reported = readCodexContextMode(metadata?.codexContextMode);
    if (!reported) return undefined;
    if (!metadata?.codexThreadId && !metadata?.currentModelCode && reported === CODEX_CONTEXT_DEFAULT_MODE) return null;
    return reported;
}

/**
 * The 「上下文」 run pick (B-849b rules, happy-wire reconcileRunPick): a local
 * pick the wrapper has not echoed is pending and wins over the report, unless
 * another device's choice reached the wrapper after it (`base` = the report
 * this device saw when its user picked).
 */
export function resolveCodexContextPick(metadata: ContextMetadata, local: string | null | undefined, base: string | null | undefined) {
    return reconcileRunPick({ local: readCodexContextMode(local) ?? null, base, intent: reportedCodexContextIntent(metadata) });
}

/**
 * The mode this session runs next: a pending local pick, else the wrapper's
 * report, else the account default, else the product default. Only a mode the
 * model can run.
 */
export function resolveCodexContextMode(
    metadata: ContextMetadata,
    local: string | null | undefined,
    accountDefault: string | null | undefined,
    base?: string | null,
): CodexContextMode {
    const windows = readCodexContextWindows(metadata?.codexContextWindows);
    const known = windows[metadata?.currentModelCode ?? ''] !== undefined || Object.keys(windows).length > 0;
    const picked = readCodexContextMode(resolveCodexContextPick(metadata, local, base).value);
    const mode = picked ?? readCodexContextMode(accountDefault) ?? CODEX_CONTEXT_DEFAULT_MODE;
    // No catalog / a model that cannot run larger: standard, never the extended default.
    return known ? mode : 'standard';
}

/**
 * B-977d: the choice to send when the wrapper has not published its window
 * table yet (no catalog at all): a pending local pick or the account default.
 * Null when nothing was chosen, the wrapper already reports a chosen mode, or
 * it is an older wrapper.
 */
export function explicitCodexContextPick(
    metadata: ContextMetadata,
    local: string | null | undefined,
    accountDefault: string | null | undefined,
    base: string | null | undefined,
): CodexContextMode | null {
    if (Object.keys(readCodexContextWindows(metadata?.codexContextWindows)).length > 0) return null;
    // An older wrapper reports no mode and takes none.
    if (reportedCodexContextIntent(metadata) === undefined) return null;
    const pick = resolveCodexContextPick(metadata, local, base);
    if (pick.state === 'pending') return readCodexContextMode(pick.value) ?? null;
    if (reportedCodexContextIntent(metadata)) return null;
    return readCodexContextMode(accountDefault) ?? null;
}

/** A local pick the wrapper echoed (or another device's later choice replaced) is no longer local. */
export function settledCodexContextPick(metadata: ContextMetadata, local: string | null | undefined, base: string | null | undefined): 'clear' | null {
    if (local === null || local === undefined) return null;
    const state = resolveCodexContextPick(metadata, local, base).state;
    return state === 'session' || state === 'superseded' ? 'clear' : null;
}

/** Formatted window for a label: 「27.2 万」 / 「约 83 万」. */
export function formatContextWindow(tokens: number): string {
    const wan = tokens / 10_000;
    const rounded = wan >= 100 ? Math.round(wan) : Math.round(wan * 10) / 10;
    return `${rounded} 万`;
}

/** Picker entries for a model that can run larger; null = no choice to offer. */
export function codexContextOptions(metadata: ContextMetadata, model: string | null | undefined): CodexContextOption[] | null {
    const windows = contextWindowsForModel(metadata, model);
    if (!windows) return null;
    return [
        { key: 'standard', window: windows.standard },
        { key: 'extended', window: windows.extended },
    ];
}

/** What Settings offers for a model (extended must differ from standard). */
export function codexContextSettingsOptions(windowOf: { standard: number; extended: number } | null): CodexContextOption[] | null {
    if (!windowOf || codexContextWindowsOf({ window: windowOf.standard, maxWindow: windowOf.extended, effectivePercent: 100 }) === null) return null;
    return [{ key: 'standard', window: windowOf.standard }, { key: 'extended', window: windowOf.extended }];
}

/**
 * B-977: Settings → Agents → Codex 「上下文」 as an account default. The
 * window is a property of the model, so take the model each machine would run
 * (its config model for 「本机配置」 / follow-latest) and use the first catalog
 * that reports it as able to run larger. No such catalog → no row (Settings
 * cannot offer a window the machines would not honor).
 */
export function settingsCodexContextOptions(input: {
    modelMode: string;
    catalogs: readonly ContextMetadata[];
    followedModelOf?: (catalog: ContextMetadata) => string | null | undefined;
}): { model: string; options: CodexContextOption[] } | null {
    for (const catalog of input.catalogs) {
        if (!catalog) continue;
        const model = input.followedModelOf?.(catalog) ?? (input.modelMode === 'default' ? catalog.configuredModel ?? catalog.defaultModelCode : input.modelMode);
        const options = codexContextOptions(catalog, model);
        if (options && model) return { model, options };
    }
    return null;
}
