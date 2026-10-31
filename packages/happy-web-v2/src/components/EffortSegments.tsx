import { useId, useState } from 'react';
import type { ModeOption } from './modelModeOptions';
import './effortSegments.css';

/** The backend orders the supported levels. Defaults/off are never a maximum. */
export function isMaximumEffort(options: ModeOption[], value: string | null): boolean {
    const last = options.at(-1)?.key;
    return options.length > 1 && value === last
        && !['default', '__code_default__', 'off', 'none'].includes(last ?? '');
}

/** Shared by the composer entry and the selected top stop; purely decorative. */
export function EffortEnergy() {
    return <span className="effort-energy" aria-hidden="true"><span className="effort-energy-flow" /><span className="effort-energy-glint" /></span>;
}

/**
 * B-849a: thinking level as named stops (「自动 · 低 · 中 · 高 · 很高 · 极限」)
 * instead of an unlabeled dot slider — every stop says what it is before it is
 * picked, and each is a ≥44px target on touch. Values are exact backend keys;
 * `value` outside the list (unknown/obsolete) selects nothing.
 */
export function EffortSegments({ label, options, value, onChange, busy = false, hint, labelHidden = false, className }: {
    label: string;
    className?: string;
    /** The surrounding row already shows the label (Settings): name the group for AT only. */
    labelHidden?: boolean;
    options: ModeOption[];
    value: string | null;
    onChange: (key: string) => void;
    busy?: boolean;
    hint?: string;
}) {
    const id = useId();
    const [burst, setBurst] = useState(0);
    if (!options.length) return null;
    const atMax = isMaximumEffort(options, value);
    const pick = (key: string) => {
        if (busy || key === value) return;
        if (isMaximumEffort(options, key)) setBurst((count) => count + 1);
        onChange(key);
    };
    return (
        <div className={['effort-seg', atMax && 'effort-seg--max', className].filter(Boolean).join(' ')}>
            {!labelHidden && <span className="effort-seg-label" id={id}>{label}</span>}
            <div className="effort-seg-row" role="radiogroup" aria-labelledby={labelHidden ? undefined : id} aria-label={labelHidden ? label : undefined}>
                {options.map((option) => {
                    const selected = option.key === value;
                    const top = selected && atMax;
                    return (
                        <button key={option.key} type="button" role="radio" aria-checked={selected} disabled={busy}
                            className={`effort-seg-stop${selected ? ' effort-seg-stop--on' : ''}`}
                            title={option.description ?? undefined}
                            onClick={() => pick(option.key)}>
                            <span>{option.name}</span>
                            {top && <EffortEnergy />}
                            {top && burst > 0 && <span key={burst} className="effort-seg-burst" aria-hidden="true" />}
                        </button>
                    );
                })}
            </div>
            {hint && <span className="effort-seg-hint">{hint}</span>}
        </div>
    );
}
