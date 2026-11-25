import {
    CODEX_CONTEXT_DEFAULT_MODE,
    codexContextWindowsOf,
    readCodexContextMode,
    readCodexContextWindows,
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
    codexContextWindows?: unknown;
    currentModelCode?: string | null;
    /** Settings: the model this machine's own config pins / Codex would run. */
    configuredModel?: string | null;
    defaultModelCode?: string | null;
} | null | undefined;

export type CodexContextOption = { key: CodexContextMode; window: number };

/** A model's two windows, or null when the machine cannot tell / the model cannot run larger. */
export function contextWindowsForModel(metadata: ContextMetadata, model: string | null | undefined): { standard: number; extended: number } | null {
    if (normalizeAgentKey(metadata?.flavor) !== 'codex' || !model) return null;
    return readCodexContextWindows(metadata?.codexContextWindows)[model] ?? null;
}

export function supportsCodexContextChoice(metadata: ContextMetadata, model: string | null | undefined): boolean {
    return contextWindowsForModel(metadata, model) !== null;
}

/**
 * The mode this session runs: the wrapper's report (it is the sole writer once
 * a message carried a pick), else the session's own local pick, else the
 * account default, else the product default. Only a mode the model can run.
 */
export function resolveCodexContextMode(
    metadata: ContextMetadata,
    local: string | null | undefined,
    accountDefault: string | null | undefined,
): CodexContextMode {
    const windows = readCodexContextWindows(metadata?.codexContextWindows);
    const known = windows[metadata?.currentModelCode ?? ''] !== undefined || Object.keys(windows).length > 0;
    const reported = readCodexContextMode(metadata?.codexContextMode);
    const mode = reported ?? readCodexContextMode(local) ?? readCodexContextMode(accountDefault) ?? CODEX_CONTEXT_DEFAULT_MODE;
    return known ? mode : CODEX_CONTEXT_DEFAULT_MODE;
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
