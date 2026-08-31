import type { NormalizedMessage } from './typesRaw';

/**
 * Plan-mode transition scan over one applied batch (extracted from
 * storage.applyMessages for testability — B-261).
 *
 * Walks the batch IN ORDER: EnterPlanMode sets true, ExitPlanMode sets false;
 * the final value says whether the batch ends inside an unresolved plan entry.
 * History replays contain both Enter and Exit, so a correctly ordered batch
 * resolves to false — which is exactly why the caller must sort DESC backfill
 * pages by seq first (sortIncomingBySeq): read backwards, [Exit, Enter]
 * ends true and loading history would re-enter plan mode.
 */
export function resolvePlanModeFromBatch(messages: NormalizedMessage[]): boolean {
    let shouldEnterPlanMode = false;
    for (const msg of messages) {
        if (msg.role !== 'agent') continue;
        for (const c of msg.content) {
            if (c.type === 'tool-call') {
                if (c.name === 'EnterPlanMode' || c.name === 'enter_plan_mode') {
                    shouldEnterPlanMode = true;
                } else if (c.name === 'ExitPlanMode' || c.name === 'exit_plan_mode') {
                    shouldEnterPlanMode = false;
                }
            }
        }
    }
    return shouldEnterPlanMode;
}
