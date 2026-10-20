import { RawJSONLinesSchema, type RawJSONLines } from '../types';

/**
 * Fork backfill (B-495): replay a forked Claude JSONL through the session
 * protocol mapper, then close the turn the replay leaves open.
 *
 * The JSONL has no `result` lines, so the mapper's `currentTurnId` stays set
 * after the last historical assistant reply. The fork's first real turn then
 * reuses that id: no `turn-start` after the prompt, and `sessions read --wait`
 * (turnState: "a turn-end only counts once a turn-start followed the prompt")
 * reads its `turn-end` as the previous turn closing — it never ends.
 * Closing here puts the history's `turn-end` before the prompt (B-531 holds
 * the prompt until every replayed envelope is committed).
 */
export function replayClaudeForkJsonl(
    file: string,
    sink: { send(line: RawJSONLines): void; closeTurn(): void },
): number {
    let replayed = 0;
    for (const line of file.split('\n')) {
        if (line.trim().length === 0) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        const result = RawJSONLinesSchema.safeParse(parsed);
        if (!result.success) continue;
        sink.send(result.data as RawJSONLines);
        replayed += 1;
    }
    if (replayed > 0) sink.closeTurn();
    return replayed;
}
