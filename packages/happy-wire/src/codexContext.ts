import { z } from 'zod';

// B-963: how full a Codex thread's context is, from the app-server's
// `thread/tokenUsage/updated` ({ total, last, modelContextWindow }). Occupancy
// is `last` (the newest request); `total` is the session's running sum and only
// feeds usage reports. The wrapper mirrors it into agentState
// (`codexContextUsage`), a field of its own: `contextUsage` is pi's, and its
// `source: 'pi'` literal would make an older web drop the whole agentState.
// Wrappers that write it declare CODEX_CONTEXT_CAPABILITY (AGENTS #14).

export const CODEX_CONTEXT_CAPABILITY = 'codex-context-v1';

/** Child threads kept in agentState, newest first. */
export const CODEX_CONTEXT_MAX_CHILDREN = 16;

const occupancy = {
    /** null = not measured since the history changed (rewind). */
    tokens: z.number().finite().nonnegative().nullable(),
    /** Codex's own window for the model; null when it reports none. */
    contextWindow: z.number().finite().positive().nullish(),
};

export const CodexContextUsageSchema = z.object({
    /** The session's own thread; a reader ignores the numbers of another thread (cleared, not resumed). */
    threadId: z.string(),
    ...occupancy,
    updatedAt: z.number(),
    /** The session's sub-agent threads, newest first. */
    children: z.array(z.object({ threadId: z.string(), ...occupancy })).nullish().catch(undefined),
});
export type CodexContextUsage = z.infer<typeof CodexContextUsageSchema>;

/** agentState.codexContextUsage → usage, or null (absent or malformed). */
export function readCodexContextUsage(raw: unknown): CodexContextUsage | null {
    const parsed = CodexContextUsageSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

/**
 * Occupancy of one ThreadTokenUsage. Input side of the newest request (cached
 * input is part of inputTokens), as the Claude meter counts. After a compaction
 * Codex reports an estimate with every breakdown field 0 and only totalTokens
 * set — that estimate is the occupancy, not 0.
 */
export function codexContextOccupancy(raw: unknown): { tokens: number; contextWindow: number | null } | null {
    const usage = raw && typeof raw === 'object' ? raw as Record<string, any> : null;
    const last = usage?.last && typeof usage.last === 'object' ? usage.last as Record<string, unknown> : null;
    if (!last) return null;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    const input = num(last.inputTokens);
    const tokens = input !== null && input > 0 ? input : num(last.totalTokens);
    if (!tokens) return null;
    const window = num(usage?.modelContextWindow);
    return { tokens, contextWindow: window && window > 0 ? window : null };
}

// ─── B-977: standard / extended context window ──────────────────────────────
//
// Codex sizes a thread's window from its model catalog (`codex debug models`):
// `context_window` × `effective_context_window_percent` (272k → 258,400;
// 500k → 475,000 on Codex 0.171). A thread can be given more with the
// `model_context_window` config key, which Codex clamps to the catalog's
// `max_context_window` (872k → 828,400), and it compacts at
// `model_auto_compact_token_limit`, itself clamped to 90% of that raw window.
// Measured against a local mock (no real requests), Codex 0.171:
//   no override              → window 258,400, compacts above 244,800 (272k × 90%)
//   model_context_window 1M  → window 828,400, compacts above 784,800 (872k × 90%)
//   + auto_compact 500k      → compacts above 500k; 2M behaves like no limit (clamped)
// The setting is per thread and not persisted: every thread/start, resume and
// fork must carry it, and a loaded thread ignores a resume's new config until
// `thread/unsubscribe` unloads it.

/** The wrapper honors `meta.codexContext` and reports `codexContextMode` / `codexContextWindows`. */
export const CODEX_CONTEXT_MODE_CAPABILITY = 'codex-context-mode-v1';

export const CODEX_CONTEXT_MODES = ['standard', 'extended'] as const;
export type CodexContextMode = (typeof CODEX_CONTEXT_MODES)[number];

/**
 * The mode a session runs when nobody picked one (no session pick, no account
 * default). Product decision pending with the Owner: change only this constant.
 */
export const CODEX_CONTEXT_DEFAULT_MODE: CodexContextMode = 'standard';

/** Compaction point as a share of the window, Codex's own default ratio. */
export const CODEX_AUTO_COMPACT_RATIO = 0.9;

export function readCodexContextMode(raw: unknown): CodexContextMode | null {
    return raw === 'standard' || raw === 'extended' ? raw : null;
}

/** One model's catalog sizes (raw tokens, before the effective percentage). */
export type CodexModelWindowEntry = { window: number; maxWindow: number; effectivePercent: number };

/** What a session can show: the window each mode really runs (effective tokens). */
export type CodexContextWindows = { standard: number; extended: number };

const positiveInt = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;

/** Effective windows of one model; null when it cannot run larger than standard. */
export function codexContextWindowsOf(entry: CodexModelWindowEntry | null | undefined): CodexContextWindows | null {
    if (!entry) return null;
    const standard = Math.floor(entry.window * entry.effectivePercent / 100);
    const extended = Math.floor(entry.maxWindow * entry.effectivePercent / 100);
    return extended > standard ? { standard, extended } : null;
}

/**
 * The thread config for `mode`, on a model that can run larger (else nothing:
 * Codex's own default). Extended asks for the catalog maximum, standard for
 * the catalog window — exactly Codex's default, but said explicitly, because a
 * thread reloaded within one app-server keeps keys a resume omits (measured:
 * extended → standard with no keys stayed at 828,400). Both compact at the
 * 90% Codex uses by default.
 */
export function codexContextThreadConfig(mode: CodexContextMode, entry: CodexModelWindowEntry | null | undefined): Record<string, number> {
    if (!entry || !codexContextWindowsOf(entry)) return {};
    const window = mode === 'extended' ? entry.maxWindow : entry.window;
    return { model_context_window: window, model_auto_compact_token_limit: Math.floor(window * CODEX_AUTO_COMPACT_RATIO) };
}

/** `codex debug models` JSON → per-model sizes. Unknown shapes give an empty map. */
export function parseCodexModelWindows(raw: unknown): Map<string, CodexModelWindowEntry> {
    const out = new Map<string, CodexModelWindowEntry>();
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { models?: unknown }).models) ? (raw as { models: unknown[] }).models : [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const model = item as Record<string, unknown>;
        const slug = typeof model.slug === 'string' ? model.slug : null;
        const window = positiveInt(model.context_window);
        if (!slug || window === null) continue;
        const maxWindow = Math.max(window, positiveInt(model.max_context_window) ?? window);
        const percent = positiveInt(model.effective_context_window_percent);
        out.set(slug, { window, maxWindow, effectivePercent: percent !== null && percent <= 100 ? percent : 100 });
    }
    return out;
}

/** metadata.codexContextWindows → model → windows (malformed entries dropped). */
export function readCodexContextWindows(raw: unknown): Record<string, CodexContextWindows> {
    const out: Record<string, CodexContextWindows> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const standard = positiveInt((value as Record<string, unknown>).standard);
        const extended = positiveInt((value as Record<string, unknown>).extended);
        if (standard !== null && extended !== null && extended > standard) out[model] = { standard, extended };
    }
    return out;
}
