import { createContext, lazy, Suspense, useCallback, useContext, useRef, useState, type AnchorHTMLAttributes } from 'react';
import { skillDocumentUrl } from './skillDocumentUrl';

// Keep the document renderer out of ordinary help/link bundles and avoid a
// static Markdown → link → Markdown dependency cycle.
const SkillDocumentPreview = lazy(() => import('./SkillDocumentPreview'));
export const SkillDocumentBase = createContext<{ url: string; navigate: (url: string) => void } | undefined>(undefined);

/** A real link for copy/context menus; an ordinary click reads it in this page. */
export function SkillDocumentLink({ href, onClick, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
    const document = useContext(SkillDocumentBase);
    const [open, setOpen] = useState(false);
    const [ready, setReady] = useState(false);
    const markReady = useCallback(() => setReady(true), []);
    const trigger = useRef<HTMLAnchorElement>(null);
    const pageUrl = typeof window === 'undefined' ? 'https://veryhappy.dev/' : window.location.href;
    const url = skillDocumentUrl(href, pageUrl, document?.url, import.meta.env.BASE_URL);
    if (!url) return <a {...props} href={href} onClick={onClick}>{children}</a>;
    return <>
        <a {...props} ref={trigger} href={url} target={undefined} aria-haspopup={document ? undefined : 'dialog'} aria-busy={open && !ready || undefined} onClick={event => {
            onClick?.(event);
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (document) { document.navigate(url); return; }
            setReady(false);
            setOpen(true);
        }}>{children}</a>
        {open && <Suspense fallback={null}><SkillDocumentPreview url={url} onReady={markReady} onClose={() => setOpen(false)} returnFocus={() => trigger.current?.focus({ preventScroll: true })} /></Suspense>}
    </>;
}
