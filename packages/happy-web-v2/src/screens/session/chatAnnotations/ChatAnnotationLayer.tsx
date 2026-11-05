/**
 * B-891: the transcript side of in-place comments — a tint over each
 * commented passage (CSS Custom Highlight, no DOM mutation, so React's tree,
 * copy and selection-quote paths are untouched) and a numbered marker after
 * it. Lives inside `.cl-inner` so markers scroll with the text natively; it
 * re-locates on transcript mutations and resizes (streaming, history loading,
 * folds) and reports which comments are stale.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from '@/i18n/useTranslation';
import { excerptPreview } from './chatAnnotations';
import { locateInDom } from './chatAnnotationDom';
import { getChatAnnotations, openAnnotationEditor, reportAnchorState, useAnnotationEditor, useChatAnnotations } from './chatAnnotationsStore';
import './chatAnnotations.css';

const HIGHLIGHT_NAME = 'vh-annotation';
const MARKER = 18;

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
function highlightRegistry(): { registry: HighlightRegistry; Ctor: new (...r: Range[]) => unknown } | null {
    const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
    const Ctor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    return css?.highlights && Ctor ? { registry: css.highlights, Ctor } : null;
}

type Marker = { id: string; n: number; left: number; top: number; tipLeft: boolean };

function sameMarkers(a: readonly Marker[], b: readonly Marker[]): boolean {
    return a.length === b.length && a.every((m, i) => {
        const o = b[i];
        return o.id === m.id && o.n === m.n && Math.abs(o.left - m.left) < 0.5 && Math.abs(o.top - m.top) < 0.5 && o.tipLeft === m.tipLeft;
    });
}

/** The visible part of a range's last line box, clipped by a clamped (collapsed) bubble. */
function lastVisibleRect(range: Range): DOMRect | null {
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    const clip = (range.commonAncestorContainer.nodeType === 1
        ? range.commonAncestorContainer as Element
        : range.commonAncestorContainer.parentElement)?.closest('.msg-bubble-text--clamped')?.getBoundingClientRect();
    for (let i = rects.length - 1; i >= 0; i--) {
        if (!clip || rects[i].bottom <= clip.bottom + 1) return rects[i];
    }
    return null;
}

export function ChatAnnotationLayer({ sessionId, innerRef, enabled }: { sessionId: string; innerRef: RefObject<HTMLElement | null>; enabled: boolean }) {
    const { t } = useTranslation();
    const annotations = useChatAnnotations(sessionId);
    const editor = useAnnotationEditor();
    const layerRef = useRef<HTMLDivElement>(null);
    const [markers, setMarkers] = useState<Marker[]>([]);
    const markersRef = useRef<Marker[]>([]);
    // A new comment being written: its passage stays tinted while focus is in the editor.
    const pending = editor?.kind === 'new' && editor.sessionId === sessionId ? editor.anchor : null;
    const pendingRef = useRef(pending);
    pendingRef.current = pending;
    const active = enabled && (annotations.length > 0 || !!pending);

    const relocate = useRef<() => void>(() => {});
    relocate.current = () => {
        const inner = innerRef.current;
        const layer = layerRef.current;
        const hl = highlightRegistry();
        if (!inner || !layer || !active) {
            hl?.registry.delete(HIGHLIGHT_NAME);
            if (markersRef.current.length) { markersRef.current = []; setMarkers([]); }
            return;
        }
        const box = layer.getBoundingClientRect();
        const ranges: Range[] = [];
        const next: Marker[] = [];
        const found: string[] = [];
        const stale: string[] = [];
        getChatAnnotations(sessionId).forEach((a, i) => {
            const at = locateInDom(inner, a);
            if (at.kind === 'absent') return;
            if (at.kind === 'stale') { stale.push(a.id); return; }
            found.push(a.id);
            ranges.push(at.range);
            const last = lastVisibleRect(at.range);
            if (!last) return;
            const left = Math.min(last.right - box.left + 2, box.width - MARKER);
            next.push({ id: a.id, n: i + 1, left, top: last.top - box.top - 4, tipLeft: left > box.width / 2 });
        });
        const draft = pendingRef.current;
        if (draft) {
            const at = locateInDom(inner, draft);
            if (at.kind === 'found') ranges.push(at.range);
        }
        reportAnchorState(sessionId, found, stale);
        if (hl) {
            if (ranges.length) hl.registry.set(HIGHLIGHT_NAME, new hl.Ctor(...ranges));
            else hl.registry.delete(HIGHLIGHT_NAME);
        }
        if (!sameMarkers(markersRef.current, next)) { markersRef.current = next; setMarkers(next); }
    };

    useLayoutEffect(() => { relocate.current(); }, [annotations, active, pending]);

    useEffect(() => {
        const inner = innerRef.current;
        if (!active || !inner) return;
        let raf = 0;
        const schedule = () => {
            if (raf) return;
            raf = requestAnimationFrame(() => { raf = 0; relocate.current(); });
        };
        // Our own markers live inside the observed tree: ignore their mutations or this loops.
        const mutations = new MutationObserver((records) => {
            const layer = layerRef.current;
            if (records.some((r) => !layer || !layer.contains(r.target))) schedule();
        });
        mutations.observe(inner, { childList: true, subtree: true, characterData: true });
        const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
        resize?.observe(inner);
        window.addEventListener('resize', schedule);
        return () => {
            if (raf) cancelAnimationFrame(raf);
            mutations.disconnect();
            resize?.disconnect();
            window.removeEventListener('resize', schedule);
        };
    }, [active, innerRef]);

    useEffect(() => () => { highlightRegistry()?.registry.delete(HIGHLIGHT_NAME); }, []);

    if (!active) return null;
    const byId = new Map(annotations.map((a) => [a.id, a]));
    const openId = editor?.kind === 'edit' && editor.sessionId === sessionId ? editor.id : null;
    return (
        <div ref={layerRef} className="can-layer" aria-hidden={markers.length === 0 ? true : undefined}>
            {markers.map((m) => {
                const a = byId.get(m.id);
                if (!a) return null;
                const label = t('session.chat.annotations.markerLabel', { n: m.n, body: excerptPreview(a.body, 120) });
                return (
                    <button
                        key={m.id}
                        type="button"
                        className={`can-marker${openId === m.id ? ' can-marker--open' : ''}`}
                        style={{ left: m.left, top: m.top }}
                        aria-label={label}
                        data-annotation-id={m.id}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                            const r = event.currentTarget.getBoundingClientRect();
                            openAnnotationEditor({ sessionId, kind: 'edit', id: m.id, place: { left: r.left, top: r.top, bottom: r.bottom } });
                        }}
                    >
                        {m.n}
                        <span className={`can-tip${m.tipLeft ? ' can-tip--left' : ''}`} role="presentation">{a.body}</span>
                    </button>
                );
            })}
        </div>
    );
}
