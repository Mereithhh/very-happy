/**
 * Which terminal-header controls stay on the bar, and which move into the
 * overflow menu.
 *
 * The header grew eight independently-added rigid controls over ten weeks and
 * nothing ever gave any of them a priority. Measured against the real CSS in a
 * browser at 2026-09-03: on a 390px phone the full set is ~468px of rigid
 * content, and while a transient status chip is showing (opening a terminal, or
 * the first load while the CJK font downloads) the whole button cluster is
 * pushed 167-237px past the right edge — where nothing can scroll to it because
 * .app-detail clips. That is how the user lost the structured-view toggle.
 *
 * The policy, in priority order:
 *  1. Back and the title always stay — the title is what tells you WHICH
 *     terminal you are in, and it used to be squeezed to literally 0px.
 *  2. The structured-view toggle stays on the bar whenever it exists. This is
 *     the B-105 rule ("mobile must reach it in one glance, never inside a
 *     menu") and it survives untouched — the other controls moved so that it
 *     could keep being true.
 *  3. Everything else collapses into one "⋯" trigger on compact viewports.
 *     Desktop is untouched: it has the room, and the presets menu there is a
 *     keyboard-first affordance.
 */
export type TermHeaderActionKey =
    | 'structured'
    | 'notes'
    | 'select'
    | 'presets'
    | 'files'
    | 'refit'
    | 'tmuxHelp';

export type TermHeaderLayoutInput = {
    /** Viewport too narrow for the full cluster (see the measurement above). */
    compact: boolean;
    /** The daemon reports a mirrored structured session for this terminal. */
    hasMirror: boolean;
    /** Single-pane shell (narrow or touch) — where select-mode is offered. */
    showSelect: boolean;
    /** Fine pointer — where the keyboard-first presets picker is offered. */
    showPresets: boolean;
    hasTmuxSession: boolean;
};

export type TermHeaderLayout = {
    /** Rendered as icon buttons on the bar, in this order. */
    inline: TermHeaderActionKey[];
    /** Rendered as items in the "⋯" menu, in this order. Empty ⇒ no trigger. */
    overflow: TermHeaderActionKey[];
};

export function planTermHeaderActions(input: TermHeaderLayoutInput): TermHeaderLayout {
    const available: TermHeaderActionKey[] = [];
    if (input.hasMirror) available.push('structured');
    available.push('notes');
    if (input.showSelect) available.push('select');
    if (input.showPresets) available.push('presets');
    available.push('files');
    available.push('refit');
    if (input.hasTmuxSession) available.push('tmuxHelp');

    if (!input.compact) return { inline: available, overflow: [] };

    // `presets` is a picker with its own panel, not an action — it cannot be an
    // item in an action menu, and it only exists on a fine pointer (where a
    // narrow window is a resized desktop, not a phone). It stays on the bar.
    const staysInline = (key: TermHeaderActionKey) => key === 'structured' || key === 'presets';
    return {
        inline: available.filter(staysInline),
        overflow: available.filter((key) => !staysInline(key)),
    };
}
