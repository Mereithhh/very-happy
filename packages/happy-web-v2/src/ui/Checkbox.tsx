/**
 * B-714 (UI-P1-08) — the only place a native checkbox may appear (design lint
 * `native-control`). The input stays native for forms, `required` and screen
 * readers; `appearance: none` turns it into a 16px token-coloured box so it no
 * longer shows system blue or inherits a parent `input { … }` field style.
 * With children it is a full-row <label> (44px on coarse pointers); without,
 * just the box — for rows that already are a <label>.
 */
import { Check, Minus } from 'lucide-react';
import React from 'react';
import './controls.css';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'children'> {
    checked: boolean;
    onCheckedChange?: (checked: boolean) => void;
    onChange?: React.ChangeEventHandler<HTMLInputElement>;
    /** mixed state (select-all with a partial selection) */
    indeterminate?: boolean;
    children?: React.ReactNode;
    /** class on the outer label / box wrapper */
    className?: string;
}

export function Checkbox({ checked, onCheckedChange, onChange, indeterminate = false, children, className, ...input }: CheckboxProps) {
    const ref = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => {
        if (ref.current) ref.current.indeterminate = indeterminate;
    }, [indeterminate]);
    const box = (
        <span className="vh-checkbox-control">
            <input
                {...input}
                ref={ref}
                type="checkbox"
                className="vh-checkbox-input"
                checked={checked}
                aria-checked={indeterminate ? 'mixed' : undefined}
                onChange={(e) => {
                    onChange?.(e);
                    onCheckedChange?.(e.target.checked);
                }}
            />
            <span className="vh-checkbox-mark" aria-hidden="true">
                {indeterminate ? <Minus size={12} strokeWidth={3} /> : <Check size={12} strokeWidth={3} />}
            </span>
        </span>
    );
    if (children === undefined) {
        return <span className={['vh-checkbox', 'is-bare', className].filter(Boolean).join(' ')}>{box}</span>;
    }
    return (
        <label className={['vh-checkbox', input.disabled ? 'is-disabled' : '', className].filter(Boolean).join(' ')}>
            {box}
            <span className="vh-checkbox-label">{children}</span>
        </label>
    );
}
