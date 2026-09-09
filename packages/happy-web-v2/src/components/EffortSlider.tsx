import { useId, useState, type CSSProperties } from 'react';
import type { ModeOption } from './modelModeOptions';
import './effortSlider.css';

/** Values are exact backend keys; the range only indexes the supported list. */
export function EffortSlider({ label, options, value, onChange, busy = false, hint }: {
    label: string;
    options: ModeOption[];
    value: string | null;
    onChange: (key: string) => void;
    busy?: boolean;
    hint?: string;
}) {
    const id = useId();
    const [burst, setBurst] = useState(0);
    if (!options.length) return null;
    const index = options.findIndex((option) => option.key === value);
    // Unknown/default is a separate stop; low/off remains directly selectable.
    const minimum = index < 0 ? -1 : 0;
    const selected = index;
    const atMax = selected === options.length - 1 && options.length > 1;
    const pick = (next: number) => {
        const key = options[next]?.key;
        if (!key || busy) return;
        if (next === options.length - 1 && value !== key) setBurst((count) => count + 1);
        onChange(key);
    };
    return (
        <div className={`effort-slider${atMax ? ' effort-slider--max' : ''}`}>
            <div className="effort-slider-heading">
                <label htmlFor={id}>{label}</label>
                <output htmlFor={id}>{index < 0 ? (value ?? 'default') : options[selected].name}</output>
            </div>
            <div className="effort-slider-control" style={{ '--effort-position': `${(selected - minimum) / Math.max(1, options.length - 1 - minimum) * 100}%` } as CSSProperties}>
                <span className="effort-slider-rail" aria-hidden="true"><span /></span>
                <span className="effort-slider-ticks" aria-hidden="true">{options.map((option) => <i key={option.key} />)}</span>
                {burst > 0 && <span key={burst} className="effort-slider-burst" aria-hidden="true"><i /><i /><i /></span>}
                <input id={id} type="range" min={minimum} max={options.length - 1} step={1}
                    value={selected} disabled={busy || (options.length < 2 && index >= 0)}
                    aria-valuetext={index < 0 ? (value ?? 'default') : options[selected].name}
                    onChange={(event) => pick(Number(event.target.value))} />
            </div>
            {hint && <span className="effort-slider-hint">{hint}</span>}
        </div>
    );
}
