/**
 * B-714 — free text with suggestions: replaces the native input list + datalist pair
 * (a native, unthemed dropdown). The value is whatever is typed; the list
 * only offers completions (directory presets, time zones).
 *
 * APG «editable combobox with list autocomplete»: focus stays in the input
 * (role=combobox, aria-activedescendant); ↑↓ move, Enter takes the highlighted
 * suggestion, Esc closes the list first. Same popover surface as the pickers,
 * portalled into an enclosing native modal <dialog> when there is one.
 */
import * as Popover from '@radix-ui/react-popover';
import React from 'react';
import { filterOptions, highlightRuns, moveActive, type PickerOption } from './picker/pickerModel';
import './picker/picker.css';

const MAX_ROWS = 50;

export interface SuggestInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'list'> {
    value: string;
    onValueChange: (value: string) => void;
    suggestions: readonly (string | PickerOption)[];
    /** the underlying input (focus management) */
    inputRef?: React.Ref<HTMLInputElement>;
}

export function SuggestInput({ value, onValueChange, suggestions, inputRef: externalRef, onKeyDown, onFocus, onBlur, className, ...input }: SuggestInputProps) {
    const baseId = `vh-suggest-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const setInput = React.useCallback((el: HTMLInputElement | null) => {
        inputRef.current = el;
        if (typeof externalRef === 'function') externalRef(el);
        else if (externalRef) (externalRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
    }, [externalRef]);
    const [open, setOpen] = React.useState(false);
    const [active, setActive] = React.useState(-1);
    const [portalHost, setPortalHost] = React.useState<HTMLElement | undefined>(undefined);
    const options = React.useMemo<PickerOption[]>(() => suggestions.map((s) => typeof s === 'string' ? { value: s, label: s } : s), [suggestions]);
    // an exact match lists everything (the field is "filled", show alternatives)
    const exact = options.some((o) => o.value === value);
    const visible = React.useMemo(() => (exact ? options : filterOptions(options, value)).slice(0, MAX_ROWS), [options, value, exact]);
    const shown = open && visible.length > 0;

    const show = () => {
        setPortalHost(inputRef.current?.closest('dialog') ?? undefined);
        setOpen(true);
    };
    const take = (index: number) => {
        const option = visible[index];
        if (!option || option.disabled) return;
        onValueChange(option.value);
        setOpen(false);
        setActive(-1);
    };

    return (
        <Popover.Root open={shown} onOpenChange={(next) => { if (!next) setOpen(false); }}>
            <Popover.Anchor asChild>
                <input
                    {...input}
                    ref={setInput}
                    className={className}
                    value={value}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={shown}
                    aria-controls={shown ? `${baseId}-list` : undefined}
                    aria-activedescendant={shown && active >= 0 ? `${baseId}-opt-${active}` : undefined}
                    autoComplete="off"
                    onChange={(e) => { onValueChange(e.target.value); show(); setActive(-1); }}
                    onFocus={onFocus}
                    onClick={() => { if (!open) show(); }}
                    onBlur={(e) => { onBlur?.(e); setOpen(false); }}
                    onKeyDown={(e) => {
                        onKeyDown?.(e);
                        if (e.defaultPrevented || e.nativeEvent.isComposing) return;
                        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                            e.preventDefault();
                            if (!open) { show(); return; }
                            setActive((i) => moveActive(visible, i, e.key === 'ArrowDown' ? 1 : -1));
                        } else if (e.key === 'Enter' && shown && active >= 0) {
                            e.preventDefault();
                            take(active);
                        }
                    }}
                />
            </Popover.Anchor>
            <Popover.Portal container={portalHost}>
                <Popover.Content
                    className="vh-picker vh-suggest"
                    data-vh-picker-surface=""
                    align="start"
                    sideOffset={4}
                    collisionPadding={12}
                    onOpenAutoFocus={(e) => e.preventDefault()}
                    // Esc closes the list, not the dialog/panel around the field: Radix sees it
                    // first (document capture) and preventDefaults; stop it there too.
                    onEscapeKeyDown={(e) => e.stopPropagation()}
                    onCloseAutoFocus={(e) => e.preventDefault()}
                    onInteractOutside={(e) => { if (e.target === inputRef.current) e.preventDefault(); }}
                    style={{ minWidth: 'var(--radix-popover-trigger-width)' }}
                >
                    <div id={`${baseId}-list`} role="listbox" aria-label={input['aria-label']} className="vh-picker-list">
                        {visible.map((option, index) => (
                            <div
                                key={option.value}
                                id={`${baseId}-opt-${index}`}
                                role="option"
                                aria-selected={option.value === value}
                                aria-disabled={option.disabled || undefined}
                                data-active={index === active || undefined}
                                className="vh-picker-option"
                                title={option.label}
                                onPointerMove={() => { if (active !== index) setActive(index); }}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => take(index)}
                            >
                                <span className="vh-picker-text">
                                    <span className="vh-picker-label">{highlightRuns(option.label, exact ? '' : value).map((run, i) => run.match
                                        ? <mark key={i} className="vh-picker-match">{run.text}</mark>
                                        : <React.Fragment key={i}>{run.text}</React.Fragment>)}</span>
                                    {option.description && <span className="vh-picker-desc">{option.description}</span>}
                                </span>
                                {option.meta && <span className="vh-picker-meta">{option.meta}</span>}
                            </div>
                        ))}
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
