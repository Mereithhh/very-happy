/**
 * messageHoverTime — pure helpers for the transcript's hover time bubble
 * (B-473).
 *
 * Every row in the transcript already carries its full timestamp in a `title`
 * attribute, so hovering a message *does* eventually produce a tooltip — the
 * OS one, after roughly a second, unstyled, at the mouse, and cancelled
 * whenever React re-renders the subtree under the cursor. During a live turn
 * that subtree re-renders constantly, so in the case that matters most the
 * hint simply never appears.
 *
 * The component built on these helpers takes over: one delegated listener on
 * the scroll container reads the `title` of the row under the pointer, blanks
 * it for as long as the pointer stays there (so the OS tooltip cannot also
 * fire) and renders the text itself. Only ROW containers participate —
 * buttons keep their own native tooltips, which are short labels, not times.
 *
 * No React, no DOM writes here: everything the component decides is a function
 * of (element, geometry), unit-tested in messageHoverTime.test.ts.
 */

/** Row containers that carry a message timestamp. Buttons are deliberately
 *  absent: their titles are action labels ("Copy message"), not times. */
export const HOVER_TIME_ROW_SELECTOR = [
    '.msg',            // chat message (user / agent / event / thinking)
    '.tg-row',         // one tool call inside an activity group
    '.tg-head',        // a collapsed tool group (its own time range)
    '.tg-preview-row', // file-preview pointer row
    '.sa-brief',       // sub-agent briefing
    '.msg-time',       // the visible HH:MM chip
].join(',');

/** Attribute the live title is parked in while our bubble owns the row. */
export const HOVER_TIME_PARKED_ATTR = 'data-hover-time';

/**
 * The row whose timestamp should be shown for a pointer event on `node`, or
 * null when the pointer is not over one (or over a row with no time yet).
 * `root` bounds the search so a row outside the transcript never matches.
 */
export function hoverTimeTargetFrom(node: EventTarget | null, root: Element | null): HTMLElement | null {
    if (!(node instanceof Element) || !root) return null;
    const row = node.closest<HTMLElement>(HOVER_TIME_ROW_SELECTOR);
    if (!row || !root.contains(row)) return null;
    return hoverTimeTextOf(row) ? row : null;
}

/** The timestamp a row would show: its live `title`, or the one we parked. */
export function hoverTimeTextOf(row: HTMLElement): string | null {
    const parked = row.getAttribute(HOVER_TIME_PARKED_ATTR);
    if (parked) return parked;
    const title = row.getAttribute('title');
    return title && title.trim() ? title : null;
}

export interface TooltipRect { width: number; height: number }
export interface TooltipViewport { width: number; height: number }

/**
 * Where to place the bubble for a pointer at (x, y): above the pointer by
 * `gap`, horizontally centred, and clamped into the viewport with an 8px
 * margin. Flips below when there is no room above — a message at the very top
 * of a tall transcript must not have its time cut off by the window edge.
 */
export function clampTooltipPosition(
    pointer: { x: number; y: number },
    tooltip: TooltipRect,
    viewport: TooltipViewport,
    gap = 14,
    margin = 8,
): { left: number; top: number } {
    const left = Math.min(
        Math.max(margin, pointer.x - tooltip.width / 2),
        Math.max(margin, viewport.width - tooltip.width - margin),
    );
    const above = pointer.y - gap - tooltip.height;
    const top = above >= margin
        ? above
        : Math.min(pointer.y + gap, Math.max(margin, viewport.height - tooltip.height - margin));
    return { left: Math.round(left), top: Math.round(top) };
}

/** Hover tooltips are a pointer affordance; a touch device has no hover and
 *  must keep the native long-press behaviour instead. */
export function supportsHoverTooltip(win: { matchMedia?: (q: string) => { matches: boolean } } | undefined): boolean {
    if (!win?.matchMedia) return false;
    try {
        return win.matchMedia('(hover: hover) and (pointer: fine)').matches;
    } catch {
        return false;
    }
}
