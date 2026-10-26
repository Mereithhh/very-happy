import { useEffect, useRef } from 'react';

/**
 * B-825: an agent-written HTML file, rendered. Was `<iframe srcDoc>`, but a
 * srcdoc document inherits this app's Content-Security-Policy, which blocks
 * the page's own inline scripts and CDN assets. The frame now loads
 * `public/html-preview.html` — served with its own policy, sandboxed into an
 * opaque origin like before (no `allow-same-origin`: its scripts cannot read
 * this app's storage or DOM) — and receives the HTML by postMessage once it
 * says it is ready.
 */
export const HTML_PREVIEW_URL = `${import.meta.env.BASE_URL}html-preview.html`;

export function isHtmlPreviewReady(event: Pick<MessageEvent, 'source' | 'data'>, frame: Window | null | undefined): boolean {
    return !!frame && event.source === frame && (event.data as { type?: unknown } | null)?.type === 'vh-html-preview-ready';
}

export function HtmlPreviewFrame({ html, title }: { html: string; title: string }) {
    const ref = useRef<HTMLIFrameElement>(null);
    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            const frame = ref.current?.contentWindow;
            if (!isHtmlPreviewReady(event, frame)) return;
            // The frame's origin is opaque ("null"): '*' is the only target that reaches it.
            frame!.postMessage({ type: 'vh-html-preview', html }, '*');
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [html]);
    return (
        <iframe
            key={html}
            ref={ref}
            className="fsb-html"
            title={title}
            src={HTML_PREVIEW_URL}
            sandbox="allow-scripts allow-popups allow-forms allow-modals"
            referrerPolicy="no-referrer"
        />
    );
}
