/**
 * B-714 — pure list model behind SelectMenu / Combobox (ui/picker/Picker.tsx).
 *
 * Kept free of React and the DOM so keyboard movement, typeahead, filtering
 * and match highlighting are tested as plain functions. Options are a flat
 * array; grouping is derived from each option's `group` in first-seen order.
 */

export interface PickerOption<V extends string = string> {
    value: V;
    label: string;
    /** second line, 12px faint — e.g. why a disabled machine is unavailable */
    description?: string;
    /** right-aligned meta — 「离线」「默认」 */
    meta?: string;
    disabled?: boolean;
    /** group heading; consecutive or not, options with the same group render together */
    group?: string;
    /** extra text the search matches against (not shown) */
    keywords?: string;
}

export interface PickerGroup<V extends string = string> {
    /** '' = options without a group (rendered first, no heading) */
    label: string;
    options: PickerOption<V>[];
}

/** Group in first-seen order; ungrouped options lead without a heading. */
export function groupOptions<V extends string>(options: readonly PickerOption<V>[]): PickerGroup<V>[] {
    const groups = new Map<string, PickerOption<V>[]>();
    groups.set('', []);
    for (const option of options) {
        const key = option.group ?? '';
        let list = groups.get(key);
        if (!list) { list = []; groups.set(key, list); }
        list.push(option);
    }
    return [...groups].filter(([, list]) => list.length > 0).map(([label, list]) => ({ label, options: list }));
}

/** Render order = navigation order: groups flattened. */
export function orderedOptions<V extends string>(options: readonly PickerOption<V>[]): PickerOption<V>[] {
    return groupOptions(options).flatMap((group) => group.options);
}

function fold(text: string): string {
    return text.toLocaleLowerCase();
}

/** Case-insensitive substring match on label, description, meta, keywords and value. */
export function filterOptions<V extends string>(options: readonly PickerOption<V>[], query: string): PickerOption<V>[] {
    const q = fold(query.trim());
    if (!q) return [...options];
    return options.filter((option) => [option.label, option.description, option.meta, option.keywords, option.value]
        .some((field) => field !== undefined && fold(field).includes(q)));
}

/** Split `text` into plain / matched runs for the first occurrence of `query`. */
export function highlightRuns(text: string, query: string): { text: string; match: boolean }[] {
    const q = query.trim();
    if (!q) return [{ text, match: false }];
    const at = fold(text).indexOf(fold(q));
    if (at < 0) return [{ text, match: false }];
    const runs = [
        { text: text.slice(0, at), match: false },
        { text: text.slice(at, at + q.length), match: true },
        { text: text.slice(at + q.length), match: false },
    ];
    return runs.filter((run) => run.text.length > 0);
}

/**
 * Next enabled index from `from` in `step` direction (±1), without wrapping —
 * the native select does not wrap either. -1 as `from` with step +1 = first.
 * Returns `from` when nothing further is enabled.
 */
export function moveActive(options: readonly PickerOption[], from: number, step: 1 | -1): number {
    for (let i = from + step; i >= 0 && i < options.length; i += step) {
        if (!options[i].disabled) return i;
    }
    return from >= 0 && from < options.length ? from : firstEnabled(options);
}

export function firstEnabled(options: readonly PickerOption[]): number {
    return options.findIndex((option) => !option.disabled);
}

export function lastEnabled(options: readonly PickerOption[]): number {
    for (let i = options.length - 1; i >= 0; i--) if (!options[i].disabled) return i;
    return -1;
}

/** Where the highlight starts on open: the selected option if enabled, else the first enabled. */
export function initialActive(options: readonly PickerOption[], value: string | null | undefined): number {
    const selected = value == null ? -1 : options.findIndex((option) => option.value === value);
    if (selected >= 0 && !options[selected].disabled) return selected;
    return firstEnabled(options);
}

/**
 * Typeahead: first enabled option whose label starts with `prefix`, searching
 * after `from` and wrapping. Repeating one letter ("aaa") cycles through the
 * options starting with it, like a native select.
 */
export function typeaheadMatch(options: readonly PickerOption[], prefix: string, from: number): number {
    if (!prefix) return -1;
    const p = fold(prefix);
    const same = [...p].every((ch) => ch === p[0]);
    const needle = same ? p[0] : p;
    // a fresh multi-letter prefix may still match the current option ("ma" while on "main")
    const start = same && p.length > 1 ? from + 1 : p.length > 1 ? from : from + 1;
    const n = options.length;
    for (let k = 0; k < n; k++) {
        const i = ((start + k) % n + n) % n;
        const option = options[i];
        if (!option.disabled && fold(option.label).startsWith(needle)) return i;
    }
    return -1;
}

/** SelectMenu has no search; Combobox shows one above this many options unless told otherwise. */
export const SEARCH_THRESHOLD = 8;

export function shouldShowSearch(searchable: boolean | 'auto', optionCount: number): boolean {
    return searchable === 'auto' ? optionCount > SEARCH_THRESHOLD : searchable;
}
