/**
 * B-714 (UI-P1-09) — the header of a native <details>: the browser triangle is
 * hidden and a lucide chevron (rotates when open) leads instead, matching the
 * other disclosures. Design lint `native-control` allows `<summary` only here.
 */
import { ChevronRight } from 'lucide-react';
import React from 'react';
import './controls.css';

export function Summary({ className, children, ...rest }: React.HTMLAttributes<HTMLElement>) {
    return (
        <summary {...rest} className={['vh-summary', className].filter(Boolean).join(' ')}>
            <ChevronRight size={14} className="vh-summary-chevron" aria-hidden="true" />
            {children}
        </summary>
    );
}
