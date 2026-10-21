import type React from 'react';

/**
 * B-714: a filter picker's popup is portalled but its key events still bubble
 * through the React tree into the session-search panel. Those keys belong to the
 * picker — Esc included (Radix has already dismissed the popup: defaultPrevented).
 */
export function pickerOwnsKey(e: React.KeyboardEvent): boolean {
    if (e.defaultPrevented) return true;
    const target = e.target instanceof Element ? e.target : null;
    return !!target && (!!target.closest('[data-vh-picker-surface]') || target.getAttribute('aria-expanded') === 'true');
}
