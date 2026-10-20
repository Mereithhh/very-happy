/**
 * B-359: when a Markdown table gets a full-screen viewer.
 *
 * On a phone the transcript column is ~358px; a table that overflows it can only
 * be side-scrolled a sliver at a time, and a long one is clipped behind
 * "Show all". Both get one button that opens the table in a viewport-sized
 * scroll box (both axes, sticky header + first column) — it fixes width and
 * height together without touching the in-flow overflow / sticky model
 * (B-357, specs/2026-09-table-collapse-and-mermaid.md §B).
 */
import { shouldCollapseTable } from './codeCollapse';

export function shouldOfferTableFullscreen(overflowing: boolean, bodyRows: number): boolean {
    return overflowing || shouldCollapseTable(bodyRows);
}

/** Column count of a hast <table>: the widest row (GFM pads rows to the header). */
export function countTableColumns(node: unknown): number {
    let max = 0;
    const walk = (n: unknown) => {
        const el = n as { tagName?: string; children?: unknown[] } | undefined;
        if (!el?.children) return;
        if (el.tagName === 'tr') {
            const cells = el.children.filter((c) => {
                const tag = (c as { tagName?: string }).tagName;
                return tag === 'th' || tag === 'td';
            }).length;
            max = Math.max(max, cells);
            return;
        }
        el.children.forEach(walk);
    };
    walk(node);
    return max;
}
