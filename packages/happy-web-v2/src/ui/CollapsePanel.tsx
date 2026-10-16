/**
 * Height-animated disclosure panel (B-612): `grid-template-rows: 0fr → 1fr`
 * on the panel, `min-height: 0; overflow: clip` on its single inner wrapper
 * (styles/base.css `.vh-collapse`). Opens and closes over `--motion-med`;
 * `prefers-reduced-motion` makes both instant.
 *
 * Children are mounted only while open or closing: after the close transition
 * ends (`transitionend`, with a timeout fallback) they unmount and the panel
 * is `hidden`, so a long transcript of collapsed blocks keeps no hidden DOM.
 *
 * It never touches scrollTop. Whoever closes it automatically decides WHEN —
 * the thinking block waits until a detached reader follows again
 * (screens/session/useLiveDisclosure.ts, B-607's rule).
 */
import React from 'react';

/** Safety net if `transitionend` never arrives (tab hidden, transition cancelled). */
const COLLAPSE_FALLBACK_MS = 320;

function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export function CollapsePanel({ open, id, className, children }: {
    open: boolean;
    id?: string;
    className?: string;
    children: React.ReactNode;
}) {
    const panelRef = React.useRef<HTMLDivElement>(null);
    const [mounted, setMounted] = React.useState(open);
    const [expanded, setExpanded] = React.useState(open);
    const prevOpen = React.useRef(open);

    React.useLayoutEffect(() => {
        if (prevOpen.current === open) return;
        prevOpen.current = open;
        if (open) {
            // Mount at 0fr first; the effect below starts the transition.
            setMounted(true);
            return;
        }
        if (!panelRef.current || panelRef.current.hidden || prefersReducedMotion()) {
            setExpanded(false);
            setMounted(false);
            return;
        }
        setExpanded(false);
    }, [open]);

    React.useLayoutEffect(() => {
        if (!open || !mounted || expanded) return;
        // Flush the 0fr style so the transition has a starting point.
        panelRef.current?.getBoundingClientRect();
        setExpanded(true);
    }, [open, mounted, expanded]);

    React.useEffect(() => {
        if (open || !mounted || expanded) return;
        const panel = panelRef.current;
        const finish = () => setMounted(false);
        const onEnd = (event: TransitionEvent) => {
            if (event.target === panel && event.propertyName === 'grid-template-rows') finish();
        };
        panel?.addEventListener('transitionend', onEnd);
        const timer = setTimeout(finish, COLLAPSE_FALLBACK_MS);
        return () => {
            panel?.removeEventListener('transitionend', onEnd);
            clearTimeout(timer);
        };
    }, [open, mounted, expanded]);

    return (
        <div
            ref={panelRef}
            id={id}
            className={`vh-collapse${expanded ? ' is-open' : ''}`}
            hidden={!mounted}
        >
            <div className="vh-collapse-inner">
                {mounted && <div className={className}>{children}</div>}
            </div>
        </div>
    );
}
