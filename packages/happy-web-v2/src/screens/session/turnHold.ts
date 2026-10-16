/**
 * B-615: which finished turns keep their live shape (answer inside the
 * activity row) because the reader was scrolled up when they ended.
 *
 * A finished turn normally moves its answer out of the activity row into a
 * row of its own. Under a reader that is in that answer, the move removes the
 * row they are looking at, and WebKit clamps scrollTop against the layout
 * without it (draftRetire.ts) — the reader was thrown 1222–2524px up.
 *
 * A turn stops being the live one when liveness drops OR when the next turn
 * starts while still live (an automation, a peer session, a background task,
 * a queued prompt). Either way, a detached reader gets the turn held, by its
 * opener's id — later turns do not release it. ChatList releases every held
 * turn at once when the reader follows the live end again and the scroll has
 * settled.
 */
export const NO_HELD_TURNS: ReadonlySet<string> = new Set();

export function holdEndedTurn(
    held: ReadonlySet<string>,
    /** Opener id of the turn that was live in the previous render. */
    previousLiveTurn: string | null,
    /** Opener id of the turn that is live now. */
    liveTurn: string | null,
    following: boolean,
): ReadonlySet<string> {
    if (previousLiveTurn === null || previousLiveTurn === liveTurn || following || held.has(previousLiveTurn)) return held;
    return new Set([...held, previousLiveTurn]);
}
