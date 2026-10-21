/**
 * B-714 — 2–4 short options that fit on one line: `.vh-segmented` buttons
 * (aria-pressed) with an optional hidden input so uncontrolled forms read the
 * value from FormData. Longer or dynamic lists → SelectMenu / Combobox.
 */
import type { LucideIcon } from 'lucide-react';

export interface SegmentedOption<V extends string = string> {
    value: V;
    label: string;
    icon?: LucideIcon;
    disabled?: boolean;
}

export function Segmented<V extends string = string>({ label, labelledBy, options, value, onChange, name, disabled, className }: {
    /** accessible name of the group (unless `labelledBy`) */
    label?: string;
    labelledBy?: string;
    options: readonly SegmentedOption<V>[];
    value: V;
    onChange: (value: V) => void;
    name?: string;
    disabled?: boolean;
    className?: string;
}) {
    return (
        <div role="group" aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} className={['vh-segmented', className].filter(Boolean).join(' ')}>
            {options.map((option) => {
                const Icon = option.icon;
                return (
                    <button
                        key={option.value}
                        type="button"
                        aria-pressed={option.value === value}
                        disabled={disabled || option.disabled}
                        onClick={() => { if (option.value !== value) onChange(option.value); }}
                    >
                        {Icon && <Icon size={14} aria-hidden="true" />}
                        <span className="vh-segmented-label">{option.label}</span>
                    </button>
                );
            })}
            {name && <input type="hidden" name={name} value={value} />}
        </div>
    );
}
