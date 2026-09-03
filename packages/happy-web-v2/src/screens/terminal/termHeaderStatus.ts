/**
 * Which status chip the terminal header shows.
 *
 * On a roomy viewport all of them can coexist. On a phone they cannot: the
 * relay chip plus both transient loading chips is ~250px of a ~360px bar, and
 * before this policy they were rigid siblings of the action cluster, so they
 * pushed it clean off the screen (measured 167-237px of unreachable overflow —
 * the structured-view toggle among the casualties).
 *
 * Compact therefore shows exactly ONE, most-urgent-first: the terminal is still
 * coming up > its font is still downloading > the steady relay/latency chip.
 * Nothing is lost — the relay chip is diagnostic, and while a terminal is
 * connecting the relay state is already implied.
 */
export type TermStatusChip = 'connecting' | 'font' | 'relay';

export function termHeaderStatusChips(input: {
    compact: boolean;
    connecting: boolean;
    fontLoading: boolean;
}): TermStatusChip[] {
    if (!input.compact) {
        const chips: TermStatusChip[] = ['relay'];
        if (input.connecting) chips.push('connecting');
        if (input.fontLoading) chips.push('font');
        return chips;
    }
    if (input.connecting) return ['connecting'];
    if (input.fontLoading) return ['font'];
    return ['relay'];
}
