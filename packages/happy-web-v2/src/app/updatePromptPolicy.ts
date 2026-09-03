/**
 * B-319 — when may an update apply itself, and when must it ask?
 *
 * If anyone is looking at the tab, it asks. That is the whole point of this
 * change: reloading a page out from under someone reads as a bug, and it was
 * reported as one. There is no "but nothing was in flight" exemption, because
 * the surprise is the complaint — an unannounced reload of an idle page looks
 * exactly as broken as an unannounced reload of a busy one.
 *
 * A hidden tab is different: nobody is there to be surprised, and applying it
 * then is what keeps the safety property that made this silent to begin with.
 * A tab left running an old shell speaks an old protocol dialect, and one such
 * client resurrected a tmux session its user had deleted (see
 * staleBundleReload). So an ignored prompt does not mean the tab stays old
 * forever — it stays old until the viewer looks away.
 *
 * Pure so the rule is testable without a DOM, and stated once so the periodic
 * check and the visibility handler cannot answer it differently.
 */
export type UpdateDecision = { action: 'apply' } | { action: 'prompt' };

export interface UpdateContext {
    /** The tab is in the background: reloading now is invisible. */
    hidden: boolean;
}

export function decideUpdate(context: UpdateContext): UpdateDecision {
    return context.hidden ? { action: 'apply' } : { action: 'prompt' };
}
