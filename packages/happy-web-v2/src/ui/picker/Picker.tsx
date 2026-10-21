/**
 * B-714 — the one picker behind `ui/SelectMenu` and `ui/Combobox`.
 *
 * Replaces every native select element (Owner 10-21:「ui 上不要用原生的 select」).
 * Built on the Radix Popover / Dialog already in the bundle instead of adding
 * @radix-ui/react-select: Radix Select has no search box, no bottom sheet and
 * no async states, so Combobox would need this code anyway.
 *
 * Surfaces
 *  - desktop / fine pointer: Radix Popover anchored to the trigger;
 *  - `(pointer: coarse) and (max-width: 600px)`: Radix Dialog as a bottom sheet
 *    (title = field name, search pinned on top, 48px rows, safe-area bottom,
 *    swipe down / scrim / Esc close).
 *
 * Accessibility (WAI-ARIA APG «select-only combobox» + «combobox with listbox»)
 *  - trigger: role=combobox, aria-haspopup=listbox, aria-expanded, aria-controls;
 *  - without a search box the trigger keeps focus and points at the highlighted
 *    option through aria-activedescendant (the sheet's listbox does the same);
 *  - with one, focus moves to the search input (role=combobox) which owns it;
 *  - options: role=option + aria-selected / aria-disabled, grouped in role=group.
 *
 * Keyboard: ↑↓ Home End, typeahead (no search), Enter / Space choose and close,
 * Esc closes back to the trigger, Tab closes and moves on, ↓ / Alt+↓ / Enter /
 * Space / a letter on the trigger open it.
 *
 * Forms: `name` renders a hidden input carrying the value (FormData works);
 * `required` adds a constraint-validated proxy whose `invalid` event shows a
 * `.tg-error` line instead of the browser bubble.
 *
 * No `@/text` import here: the public Landing renders this too and must not pull
 * the app's i18n/storage graph. App code uses the SelectMenu / Combobox wrappers,
 * which supply `text` from `t()`.
 */
import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, type LucideIcon } from 'lucide-react';
import React from 'react';
import {
    filterOptions,
    firstEnabled,
    groupOptions,
    highlightRuns,
    initialActive,
    lastEnabled,
    moveActive,
    orderedOptions,
    shouldShowSearch,
    typeaheadMatch,
    type PickerOption,
} from './pickerModel';
import './picker.css';

export type { PickerOption } from './pickerModel';

export interface PickerText {
    /** search placeholder */
    search: string;
    /** no option matches the query (or the list is empty) */
    empty: string;
    loading: string;
    retry: string;
    /** inline message when a required picker is submitted empty */
    required: string;
}

/** A trailing command row (「＋ 新建 provider…」), separated from the options. */
export interface PickerAction {
    key: string;
    label: string;
    icon?: LucideIcon;
    onSelect: () => void;
}

export interface PickerProps<V extends string = string> {
    value: V | null | undefined;
    onChange: (value: V) => void;
    options: readonly PickerOption<V>[];
    /** field name: the trigger's accessible name (unless `labelledBy`) and the sheet title */
    label: string;
    /** id of a visible <label>/heading naming the field */
    labelledBy?: string;
    /** trigger id, so a <label htmlFor> can point at it */
    id?: string;
    placeholder?: string;
    name?: string;
    required?: boolean;
    disabled?: boolean;
    /** async work behind the value (switching, saving): Spinner replaces the chevron, width unchanged */
    busy?: boolean;
    /** show a search box: 'auto' = more than 8 options */
    searchable?: boolean | 'auto';
    /** options still loading */
    loading?: boolean;
    /** options failed to load: shown inline with a retry */
    error?: string | null;
    onRetry?: () => void;
    actions?: readonly PickerAction[];
    /** field = bordered (default) · soft = filled, no border (inside a closed container) · chip = compact pill (filters) */
    variant?: 'field' | 'soft' | 'chip';
    /** sm = 32px, md = 36px (forms); both 44px on coarse pointers */
    size?: 'sm' | 'md';
    className?: string;
    /** optional leading node in the trigger (status dot, icon) */
    leading?: React.ReactNode;
    /** custom trigger text for the selected option */
    renderValue?: (option: PickerOption<V> | undefined) => React.ReactNode;
    align?: 'start' | 'end';
    onOpenChange?: (open: boolean) => void;
    /** title attribute override for the trigger (default: full selected label) */
    title?: string;
    text: PickerText;
}

const SHEET_MQ = '(pointer: coarse) and (max-width: 600px)';
const ACTION_PREFIX = '\u0000action:';
const SWIPE_CLOSE_PX = 72;
const TYPEAHEAD_RESET_MS = 600;

function useSheetMode(): boolean {
    const query = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(SHEET_MQ).matches;
    const [sheet, setSheet] = React.useState(query);
    React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mq = window.matchMedia(SHEET_MQ);
        const update = () => setSheet(mq.matches);
        update();
        mq.addEventListener?.('change', update);
        return () => mq.removeEventListener?.('change', update);
    }, []);
    return sheet;
}

const TABBABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

/** Tab out of an open picker: focus the field after (or before) the trigger. */
function focusAdjacent(from: HTMLElement, backwards: boolean) {
    const all = [...document.querySelectorAll<HTMLElement>(TABBABLE)]
        .filter((el) => el === from || (!el.closest('[data-vh-picker-surface]') && !el.hasAttribute('data-vh-picker-proxy') && el.offsetParent !== null));
    const at = all.indexOf(from);
    const next = at < 0 ? null : all[at + (backwards ? -1 : 1)];
    (next ?? from).focus();
}

function isPrintable(e: React.KeyboardEvent): boolean {
    return e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey;
}

function Highlight({ text, query }: { text: string; query: string }) {
    return <>{highlightRuns(text, query).map((run, i) => run.match
        ? <mark key={i} className="vh-picker-match">{run.text}</mark>
        : <React.Fragment key={i}>{run.text}</React.Fragment>)}</>;
}

export function Picker<V extends string = string>(props: PickerProps<V>) {
    const {
        value, onChange, options, label, labelledBy, id, placeholder, name, required, disabled, busy,
        searchable = false, loading, error, onRetry, actions, variant = 'field', size = 'sm',
        className, leading, renderValue, align = 'start', onOpenChange, title, text,
    } = props;
    const reactId = React.useId();
    const baseId = `vh-picker-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const triggerId = id ?? `${baseId}-trigger`;
    const listId = `${baseId}-list`;
    const errorId = `${baseId}-error`;
    const sheet = useSheetMode();

    const [open, setOpenState] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const [active, setActive] = React.useState(-1);
    const [requiredShown, setRequiredShown] = React.useState(false);
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const searchRef = React.useRef<HTMLInputElement>(null);
    const listRef = React.useRef<HTMLDivElement>(null);
    const skipRestoreFocus = React.useRef(false);
    const typeahead = React.useRef<{ buffer: string; at: number }>({ buffer: '', at: 0 });
    const swipe = React.useRef<{ y: number; dy: number } | null>(null);
    const [swipeOffset, setSwipeOffset] = React.useState(0);
    // Inside a native modal <dialog> (TeamDialog's showModal) everything outside
    // the top layer is inert: portal into that dialog instead of <body>.
    const [portalHost, setPortalHost] = React.useState<HTMLElement | undefined>(undefined);

    const showSearch = shouldShowSearch(searchable, options.length);
    const ordered = React.useMemo(() => orderedOptions(options), [options]);
    const visible = React.useMemo(() => orderedOptions(filterOptions(ordered, query)), [ordered, query]);
    const actionItems = React.useMemo<PickerOption[]>(() => (actions ?? []).map((a) => ({ value: `${ACTION_PREFIX}${a.key}`, label: a.label })), [actions]);
    const navItems = React.useMemo<PickerOption[]>(() => [...visible, ...actionItems], [visible, actionItems]);
    const selected = value == null ? undefined : options.find((option) => option.value === value);

    const setOpen = React.useCallback((next: boolean) => {
        setOpenState(next);
        onOpenChange?.(next);
        if (next) {
            setPortalHost(triggerRef.current?.closest('dialog') ?? undefined);
            setQuery('');
            setActive(initialActive(ordered, value));
        } else {
            setSwipeOffset(0);
            swipe.current = null;
        }
    }, [onOpenChange, ordered, value]);

    const optionId = (index: number) => `${baseId}-opt-${index}`;
    const activeId = open && active >= 0 && active < navItems.length ? optionId(active) : undefined;

    React.useEffect(() => {
        if (!activeId) return;
        const el = document.getElementById(activeId);
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    }, [activeId]);

    const commit = (index: number) => {
        const item = navItems[index];
        if (!item || item.disabled) return;
        setOpen(false);
        if (item.value.startsWith(ACTION_PREFIX)) {
            const key = item.value.slice(ACTION_PREFIX.length);
            actions?.find((a) => a.key === key)?.onSelect();
            return;
        }
        setRequiredShown(false);
        if (item.value !== value) onChange(item.value as V);
    };

    const runTypeahead = (key: string): number => {
        const now = Date.now();
        const state = typeahead.current;
        state.buffer = now - state.at > TYPEAHEAD_RESET_MS ? key : state.buffer + key;
        state.at = now;
        return typeaheadMatch(navItems, state.buffer, active);
    };

    /** Keys while open, on whichever element owns aria-activedescendant. */
    const onListKeyDown = (e: React.KeyboardEvent) => {
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setActive((i) => moveActive(navItems, i, 1));
                return;
            case 'ArrowUp':
                e.preventDefault();
                if (e.altKey) { if (active >= 0) commit(active); return; }
                setActive((i) => moveActive(navItems, i, -1));
                return;
            case 'Home':
            case 'End':
                if (showSearch && query) return; // caret movement inside a typed query
                e.preventDefault();
                setActive(e.key === 'Home' ? firstEnabled(navItems) : lastEnabled(navItems));
                return;
            case 'PageDown':
            case 'PageUp': {
                e.preventDefault();
                let i = active;
                for (let k = 0; k < 8; k++) i = moveActive(navItems, i, e.key === 'PageDown' ? 1 : -1);
                setActive(i);
                return;
            }
            case 'Enter':
                e.preventDefault();
                if (active >= 0) commit(active);
                return;
            case ' ':
                if (showSearch) return; // a space is part of the query
                e.preventDefault();
                if (active >= 0) commit(active);
                return;
            case 'Tab':
                e.preventDefault();
                skipRestoreFocus.current = true;
                setOpen(false);
                if (triggerRef.current) {
                    const trigger = triggerRef.current;
                    const backwards = e.shiftKey;
                    // after the surface unmounts, so it is not in the tab order
                    requestAnimationFrame(() => focusAdjacent(trigger, backwards));
                }
                return;
            default:
                if (!showSearch && isPrintable(e)) {
                    const match = runTypeahead(e.key);
                    if (match >= 0) setActive(match);
                }
        }
    };

    const onTriggerKeyDown = (e: React.KeyboardEvent) => {
        if (disabled) return;
        if (open) {
            // popover without search: focus stays on the trigger
            if (!showSearch && !sheet) onListKeyDown(e);
            return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(true);
            return;
        }
        if (!showSearch && isPrintable(e)) {
            e.preventDefault();
            setOpen(true);
            const match = typeaheadMatch(ordered, e.key, initialActive(ordered, value));
            typeahead.current = { buffer: e.key, at: Date.now() };
            if (match >= 0) setActive(match);
        }
    };

    const restoreFocus = (e: Event) => {
        if (skipRestoreFocus.current) {
            skipRestoreFocus.current = false;
            e.preventDefault();
            return;
        }
        if (sheet) {
            // the sheet's Dialog has no Dialog.Trigger to hand focus back to
            e.preventDefault();
            triggerRef.current?.focus({ preventScroll: true });
        }
    };

    const onOpenAutoFocus = (e: Event) => {
        e.preventDefault();
        if (showSearch) searchRef.current?.focus({ preventScroll: true });
        else if (sheet) listRef.current?.focus({ preventScroll: true });
        // popover without search: focus stays on the trigger (aria-activedescendant)
    };

    const triggerLabel = selected?.label ?? (value ? String(value) : '');
    const triggerTitle = title ?? (triggerLabel || undefined);
    const triggerText = renderValue
        ? renderValue(selected)
        : triggerLabel
            ? <span className="vh-select-value">{triggerLabel}</span>
            : <span className="vh-select-value is-placeholder">{placeholder ?? ''}</span>;

    const trigger = (
        <button
            ref={triggerRef}
            type="button"
            id={triggerId}
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open && !showSearch && !sheet ? activeId : undefined}
            aria-label={labelledBy ? undefined : label}
            aria-labelledby={labelledBy}
            aria-required={required || undefined}
            aria-invalid={requiredShown || undefined}
            aria-describedby={requiredShown ? errorId : undefined}
            aria-busy={busy || undefined}
            disabled={disabled}
            title={triggerTitle}
            className={[
                'vh-select-trigger',
                `is-${variant}`,
                `is-${size}`,
                requiredShown ? 'is-invalid' : '',
                className ?? '',
            ].filter(Boolean).join(' ')}
            onKeyDown={onTriggerKeyDown}
            onClick={sheet ? () => { if (!disabled) setOpen(!open); } : undefined}
        >
            {leading}
            {triggerText}
            <span className="vh-select-chevron" aria-hidden="true">
                {busy ? <span className="vh-spinner vh-select-spinner" /> : <ChevronDown size={16} />}
            </span>
        </button>
    );

    const listKeyHost = sheet && !showSearch;
    const body = (
        <>
            {showSearch && (
                <div className="vh-picker-search-row">
                    <input
                        ref={searchRef}
                        className="vh-picker-search"
                        type="text"
                        role="combobox"
                        aria-expanded="true"
                        aria-controls={listId}
                        aria-activedescendant={activeId}
                        aria-autocomplete="list"
                        aria-label={`${label} · ${text.search}`}
                        placeholder={text.search}
                        value={query}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) => {
                            const next = e.target.value;
                            setQuery(next);
                            // the highlight follows the filter: first enabled match
                            setActive(firstEnabled([...orderedOptions(filterOptions(ordered, next)), ...actionItems]));
                        }}
                        onKeyDown={onListKeyDown}
                    />
                </div>
            )}
            <div
                ref={listRef}
                id={listId}
                role="listbox"
                aria-label={label}
                aria-activedescendant={listKeyHost ? activeId : undefined}
                tabIndex={listKeyHost ? 0 : -1}
                className="vh-picker-list"
                onKeyDown={listKeyHost ? onListKeyDown : undefined}
            >
                {loading && <div className="vh-picker-state" role="status"><span className="vh-spinner" aria-hidden="true" />{text.loading}</div>}
                {!loading && error && (
                    <div className="vh-picker-state is-error" role="alert">
                        <span className="tg-error">{error}</span>
                        {onRetry && <button type="button" className="vh-picker-retry" onClick={onRetry}>{text.retry}</button>}
                    </div>
                )}
                {!loading && !error && visible.length === 0 && <div className="vh-picker-state" role="status">{text.empty}</div>}
                {!loading && groupOptions(visible).map((group) => {
                    const headingId = group.label ? `${baseId}-g-${group.label.replace(/[^a-zA-Z0-9_-]/g, '') || 'x'}-${visible.indexOf(group.options[0])}` : undefined;
                    const rows = group.options.map((option) => {
                        const index = visible.indexOf(option);
                        const isSelected = option.value === value;
                        return (
                            <div
                                key={option.value}
                                id={optionId(index)}
                                role="option"
                                aria-selected={isSelected}
                                aria-disabled={option.disabled || undefined}
                                data-active={index === active || undefined}
                                className="vh-picker-option"
                                title={option.label}
                                onPointerMove={() => { if (!option.disabled && active !== index) setActive(index); }}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => commit(index)}
                            >
                                <span className="vh-picker-check" aria-hidden="true">{isSelected && <Check size={14} strokeWidth={2.25} />}</span>
                                <span className="vh-picker-text">
                                    <span className="vh-picker-label"><Highlight text={option.label} query={query} /></span>
                                    {option.description && <span className="vh-picker-desc">{option.description}</span>}
                                </span>
                                {option.meta && <span className="vh-picker-meta">{option.meta}</span>}
                            </div>
                        );
                    });
                    return group.label
                        ? <div key={group.label} role="group" aria-labelledby={headingId} className="vh-picker-group">
                            <div id={headingId} className="vh-picker-group-label">{group.label}</div>
                            {rows}
                        </div>
                        : <div key="" role="presentation" className="vh-picker-group">{rows}</div>;
                })}
                {actionItems.length > 0 && (
                    <div role="group" className="vh-picker-group is-actions">
                        {actionItems.map((item, k) => {
                            const index = visible.length + k;
                            const Icon = actions?.[k]?.icon;
                            return (
                                <div
                                    key={item.value}
                                    id={optionId(index)}
                                    role="option"
                                    aria-selected={false}
                                    data-active={index === active || undefined}
                                    className="vh-picker-option is-action"
                                    onPointerMove={() => { if (active !== index) setActive(index); }}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => commit(index)}
                                >
                                    <span className="vh-picker-check" aria-hidden="true">{Icon && <Icon size={14} />}</span>
                                    <span className="vh-picker-text"><span className="vh-picker-label">{item.label}</span></span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </>
    );

    const formProxy = name || required ? (
        <>
            {name && <input type="hidden" name={name} value={value ?? ''} />}
            {required && (
                <input
                    className="vh-picker-proxy"
                    data-vh-picker-proxy=""
                    tabIndex={-1}
                    aria-hidden="true"
                    required
                    value={value ?? ''}
                    onChange={() => undefined}
                    onInvalid={(e) => {
                        e.preventDefault();
                        setRequiredShown(true);
                        triggerRef.current?.focus();
                    }}
                />
            )}
        </>
    ) : null;

    const requiredLine = requiredShown && !value
        ? <span id={errorId} className="tg-error vh-picker-required" role="alert">{text.required}</span>
        : null;

    if (sheet) {
        return (
            <>
                {trigger}
                {formProxy}
                {requiredLine}
                <Dialog.Root open={open} onOpenChange={setOpen}>
                    <Dialog.Portal container={portalHost}>
                        <Dialog.Overlay className="vh-picker-scrim" />
                        <Dialog.Content
                            className="vh-picker-sheet"
                            data-vh-picker-surface=""
                            aria-describedby={undefined}
                            style={swipeOffset ? { transform: `translateY(${swipeOffset}px)` } : undefined}
                            onOpenAutoFocus={onOpenAutoFocus}
                            onCloseAutoFocus={restoreFocus}
                        >
                            <div
                                className="vh-picker-sheet-head"
                                onPointerDown={(e) => { swipe.current = { y: e.clientY, dy: 0 }; }}
                                onPointerMove={(e) => {
                                    if (!swipe.current) return;
                                    const dy = Math.max(0, e.clientY - swipe.current.y);
                                    swipe.current.dy = dy;
                                    setSwipeOffset(dy);
                                }}
                                onPointerUp={() => {
                                    const dy = swipe.current?.dy ?? 0;
                                    swipe.current = null;
                                    if (dy > SWIPE_CLOSE_PX) setOpen(false);
                                    else setSwipeOffset(0);
                                }}
                                onPointerCancel={() => { swipe.current = null; setSwipeOffset(0); }}
                            >
                                <span className="vh-picker-grab" aria-hidden="true" />
                                <Dialog.Title className="vh-picker-sheet-title">{label}</Dialog.Title>
                            </div>
                            {body}
                        </Dialog.Content>
                    </Dialog.Portal>
                </Dialog.Root>
            </>
        );
    }

    return (
        <>
            <Popover.Root open={open} onOpenChange={(next) => { if (!disabled) setOpen(next); }}>
                <Popover.Trigger asChild>{trigger}</Popover.Trigger>
                <Popover.Portal container={portalHost}>
                    <Popover.Content
                        className="vh-picker"
                        data-vh-picker-surface=""
                        align={align}
                        sideOffset={4}
                        collisionPadding={12}
                        onOpenAutoFocus={onOpenAutoFocus}
                        onCloseAutoFocus={restoreFocus}
                    >
                        {body}
                    </Popover.Content>
                </Popover.Portal>
            </Popover.Root>
            {formProxy}
            {requiredLine}
        </>
    );
}
