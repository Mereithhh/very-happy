import type { ReasoningEffort } from './codexAppServerTypes';

type CatalogModel = {
    model: string;
    isDefault?: boolean;
    supportedReasoningEfforts: { reasoningEffort: ReasoningEffort }[];
    defaultReasoningEffort?: ReasoningEffort | null;
};

/**
 * Why a turn's reasoning effort must be refused before it reaches Codex, or
 * null to send it. Only a model the app-server's `model/list` describes can be
 * judged here: models outside that catalog (gpt-6-sol / gpt-6-luna are absent
 * from Codex 0.154's list yet run fine, up to ultra) are left for Codex itself
 * to validate — judging them against a generic list refused `ultra` outright.
 */
export function unsupportedEffortReason(
    catalog: readonly CatalogModel[],
    model: string | undefined,
    effort: ReasoningEffort | undefined,
): string | null {
    if (!effort) return null;
    const selected = catalog.find((entry) => model ? entry.model === model : entry.isDefault);
    if (!selected) return null;
    if (selected.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)) return null;
    return `Reasoning effort "${effort}" is not supported by ${model ?? 'the default model'}. Choose a supported level.`;
}

/**
 * B-849b2 (QA28 P2-4): what a turn does with an effort the catalog refuses.
 * - `explicit` (the message itself named it): the turn is refused with the
 *   reason (「未执行」 + put-back), and the wrapper's sticky effort rolls back
 *   to `fallback` — the last level a turn really started with — so the next
 *   message without meta does not fail the same way.
 * - not explicit (a sticky or restored level, e.g. an intent a wrapper before
 *   this fix recorded): the session simply has no valid choice; the turn runs
 *   on `fallback`, or — when that is refused too — the level the catalog names
 *   as the model's default (a named level every device can show; a Codex
 *   session offers no 「自动」), else no level (Codex picks).
 */
export function settleTurnEffort(
    catalog: readonly CatalogModel[],
    model: string | undefined,
    effort: ReasoningEffort | undefined,
    opts: { explicit: boolean; fallback: ReasoningEffort | undefined },
): { refusal: string | null; effort: ReasoningEffort | undefined; changed: boolean } {
    const refusal = unsupportedEffortReason(catalog, model, effort);
    if (!refusal) return { refusal: null, effort, changed: false };
    const catalogDefault = catalog.find((entry) => model ? entry.model === model : entry.isDefault)?.defaultReasoningEffort ?? undefined;
    const settled = !unsupportedEffortReason(catalog, model, opts.fallback) ? opts.fallback
        : catalogDefault && !unsupportedEffortReason(catalog, model, catalogDefault) ? catalogDefault : undefined;
    return { refusal: opts.explicit ? refusal : null, effort: settled, changed: true };
}
