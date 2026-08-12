/**
 * CopyButton — the ONE copy-to-clipboard affordance for chat content.
 *
 * Used by code blocks (CodeView bar), tool-output <pre> overlays, command
 * views and whole-message copy. Owns the clipboard write, the transient
 * "copied" check state and error feedback (toast), so the three call sites
 * can't drift.
 *
 * Two visual modes via className:
 *  - default chip (CodeView bar): pass `showLabel` for the icon+text look;
 *  - `vh-copy--overlay`: floats top-right inside a `.vh-copyhost`
 *    (position:relative) — hover-revealed on fine pointers, always visible
 *    (dimmed) on coarse pointers. Styles live in ui.css.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { toast } from './Toast';

export function CopyButton({
    text,
    className,
    showLabel = false,
    size = 13,
    label,
}: {
    /** Raw text to copy — a string, or a lazy producer for large payloads. */
    text: string | (() => string);
    className?: string;
    /** Render a text label next to the icon (code-block bar style). */
    showLabel?: boolean;
    /** Icon size in px. */
    size?: number;
    /** Accessible name / tooltip override; defaults to common.copy. */
    label?: string;
}) {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
        },
        [],
    );

    const onCopy = async () => {
        const value = typeof text === 'function' ? text() : text;
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1400);
        } catch {
            // Clipboard can be unavailable (permission / gesture policy).
            toast.error(t('markdown.copyFailed'));
        }
    };

    const name = label ?? t('common.copy');
    return (
        <button
            type="button"
            className={`vh-copy${className ? ` ${className}` : ''}`}
            onClick={onCopy}
            aria-label={name}
            title={name}
        >
            {copied ? <Check size={size} /> : <Copy size={size} />}
            {showLabel && <span>{copied ? t('common.copied') : name}</span>}
        </button>
    );
}
