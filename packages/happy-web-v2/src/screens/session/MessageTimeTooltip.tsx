/**
 * MessageTimeTooltip — the transcript's own hover time bubble (B-473).
 *
 * Mounted once per transcript; one delegated pointer listener on the scroll
 * container covers every row, present and future, with no per-message state.
 * See messageHoverTime.ts for why the native `title` tooltip was not enough.
 *
 * While a row is hovered its `title` is parked in `data-hover-time` so the OS
 * tooltip cannot fire on top of ours; it is restored on leave, on scroll, on
 * any click, and on unmount — the attribute is never left blanked, because a
 * row that lost its title would also lose its accessible name for the next
 * reader.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    HOVER_TIME_PARKED_ATTR,
    clampTooltipPosition,
    hoverTimeTargetFrom,
    hoverTimeTextOf,
    supportsHoverTooltip,
} from './messageHoverTime';

const SHOW_DELAY_MS = 220;

export function MessageTimeTooltip({ containerRef }: { containerRef: React.RefObject<HTMLElement | null> }) {
    const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
    const bubbleRef = useRef<HTMLDivElement | null>(null);
    const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);

    useEffect(() => {
        const root = containerRef.current;
        if (!root || typeof window === 'undefined' || !supportsHoverTooltip(window)) return;
        let parked: HTMLElement | null = null;
        let timer: number | undefined;

        /** Give the row its `title` back — always paired with parking it. */
        const release = () => {
            if (parked) {
                const text = parked.getAttribute(HOVER_TIME_PARKED_ATTR);
                if (text) parked.setAttribute('title', text);
                parked.removeAttribute(HOVER_TIME_PARKED_ATTR);
                parked = null;
            }
        };
        const hide = () => {
            if (timer) { window.clearTimeout(timer); timer = undefined; }
            release();
            setTip(null);
            setPlaced(null);
        };
        const onOver = (event: MouseEvent) => {
            const row = hoverTimeTargetFrom(event.target, root);
            if (!row) { hide(); return; }
            if (row === parked) return; // same row, just moving inside it
            release();
            const text = hoverTimeTextOf(row);
            if (!text) return;
            // Park the native title so only one tooltip can appear.
            row.setAttribute(HOVER_TIME_PARKED_ATTR, text);
            row.removeAttribute('title');
            parked = row;
            if (timer) window.clearTimeout(timer);
            const { clientX, clientY } = event;
            timer = window.setTimeout(() => setTip({ text, x: clientX, y: clientY }), SHOW_DELAY_MS);
        };

        root.addEventListener('mouseover', onOver);
        root.addEventListener('mouseleave', hide);
        root.addEventListener('scroll', hide, { passive: true });
        window.addEventListener('mousedown', hide, true);
        window.addEventListener('blur', hide);
        return () => {
            root.removeEventListener('mouseover', onOver);
            root.removeEventListener('mouseleave', hide);
            root.removeEventListener('scroll', hide);
            window.removeEventListener('mousedown', hide, true);
            window.removeEventListener('blur', hide);
            hide();
        };
    }, [containerRef]);

    // Measure once the text is in the DOM, then place it (a bubble rendered at
    // the pointer and then moved would flash at the wrong spot for one frame,
    // so it stays hidden until `placed` exists).
    useEffect(() => {
        if (!tip) return;
        const el = bubbleRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        setPlaced(clampTooltipPosition(
            { x: tip.x, y: tip.y },
            { width: rect.width, height: rect.height },
            { width: window.innerWidth, height: window.innerHeight },
        ));
    }, [tip]);

    if (!tip || typeof document === 'undefined') return null;
    return createPortal(
        <div
            ref={bubbleRef}
            className="msg-hover-time mono"
            role="presentation"
            style={placed ? { left: placed.left, top: placed.top } : { left: 0, top: 0, visibility: 'hidden' }}
        >
            {tip.text}
        </div>,
        document.body,
    );
}
