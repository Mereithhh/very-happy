/**
 * B-814 (spec B-807 §5.5.3): what a tab does with outbox rows it just took
 * over from a tab that is gone. Pure — sync.ts applies the plan.
 *
 * - already tracked here (B-801's first message re-sent it, same localId) → leave;
 * - already in the transcript (the server stored it; its ack was lost with
 *   the page) → drop the row, nothing to show or send;
 * - undecryptable → drop (it can be neither shown nor trusted);
 * - `queued` → re-send now with the same localId (the server dedupes);
 * - `failed` (failed before, or too old at takeover) → 「未发送 · 重发 / 丢弃」.
 */
import type { OutboxRow } from './cache/outboxStore';

export type AdoptionCandidate<R> = { row: OutboxRow; raw: R | null };

export type AdoptionPlan<R> = {
    resend: AdoptionCandidate<R>[];
    stale: AdoptionCandidate<R>[];
    drop: string[];
};

export function planOutboxAdoption<R>(
    candidates: readonly AdoptionCandidate<R>[],
    known: { tracked: (localId: string) => boolean; inTranscript: (localId: string) => boolean },
): AdoptionPlan<R> {
    const plan: AdoptionPlan<R> = { resend: [], stale: [], drop: [] };
    const ordered = [...candidates].sort((a, b) => a.row.createdAt - b.row.createdAt || a.row.order - b.row.order);
    for (const candidate of ordered) {
        const { localId } = candidate.row;
        if (known.tracked(localId)) continue;
        if (known.inTranscript(localId) || candidate.raw === null) {
            plan.drop.push(localId);
            continue;
        }
        if (candidate.row.state === 'queued') plan.resend.push(candidate);
        else plan.stale.push(candidate);
    }
    return plan;
}
