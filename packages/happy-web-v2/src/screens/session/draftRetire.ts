/**
 * B-615: a draft block leaves the transcript in two steps — hidden first,
 * removed one frame later — never removed in the commit that drops it.
 *
 * When the persisted reply lands, one React commit adds it to the live turn
 * and drops the draft that was showing the same text. The document ends up
 * as tall as before or taller, and Chromium keeps the reader's scrollTop.
 * WebKit (Safari, iOS, the PWA) does not: tearing down the draft's boxes
 * clamps the transcript's scrollTop against the OLD layout minus the removed
 * block, before the new message is laid out — a reader scrolled up into the
 * reply was thrown 1222–2524px up, to just above where the draft started
 * (probe: /dev/chat-scroll, reader 500px above the live end).
 *
 * Measured on the real page in WebKit: removing the draft node clamps; so
 * does emptying it (even when a min-height keeps its slot as tall); hiding it
 * with `display: none` in that same commit does not, and removing an
 * already-hidden node later does not either — it has no box left to tear
 * down. No scrollTop writes are involved (WebKit ignores them during momentum
 * scrolling, B-603).
 *
 * `draftRenderList` keeps blocks that disappeared since the last commit in
 * place (same key, same DOM node), flagged hidden; the next render after that
 * commit has laid out drops them.
 */
export type DraftEntry<T> = { block: T; hidden: boolean };

export function draftRenderList<T extends { key: string }>(
    committed: readonly T[],
    next: readonly T[],
): DraftEntry<T>[] {
    const nextByKey = new Map(next.map((block) => [block.key, block]));
    const entries: DraftEntry<T>[] = [];
    for (const block of committed) {
        const current = nextByKey.get(block.key);
        if (current) {
            entries.push({ block: current, hidden: false });
            nextByKey.delete(block.key);
        } else {
            entries.push({ block, hidden: true });
        }
    }
    for (const block of nextByKey.values()) entries.push({ block, hidden: false });
    return entries;
}
