import type { ReasoningEffort } from './codexAppServerTypes';

type CatalogModel = {
    model: string;
    isDefault?: boolean;
    supportedReasoningEfforts: { reasoningEffort: ReasoningEffort }[];
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
