/**
 * B-650 — ChatList side of "jump to the search hit" (see chatJump.ts).
 *
 * Message → DOM: a rendered message carries `data-message-id` (B-766: agent
 * text too) and is landed on directly; user prompts also carry
 * `data-chat-prompt-id`; everything else is found by text inside that turn (between its prompt and the next one). A hit
 * whose text is not rendered (inside a collapsed activity row) lands on the
 * turn's prompt instead. Occurrences of the query terms in the turn are
 * painted with the CSS Custom Highlight API (no DOM mutation, so React's tree
 * and the selection-quote / copy paths are untouched); browsers without it
 * just scroll.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { sync } from '@/sync/sync';
import type { Message } from '@/sync/typesMessage';
import {
    findJumpMessage,
    finishChatJump,
    MAX_JUMP_OLDER_PAGES,
    normalizeForMatch,
    onChatJumpRequest,
    peekChatJump,
    promptForMessage,
    snippetNeedle,
    type ChatJumpRequest,
} from './chatJump';

const HIGHLIGHT_NAME = 'vh-search-hit';
const HIGHLIGHT_MS = 8_000;
const FLASH_CLASS = 'chat-jump-flash';
const MAX_HIGHLIGHT_RANGES = 200;
// Older history can be held back from the DOM while the transcript is moving (B-603 heldTranscript): give it ~4.5 s.
const LOCATE_ATTEMPTS = 30;
const LOCATE_RETRY_MS = 150;

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
function highlightRegistry(): { registry: HighlightRegistry; Ctor: new (...r: Range[]) => unknown } | null {
    const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
    const Ctor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    return css?.highlights && Ctor ? { registry: css.highlights, Ctor } : null;
}

function promptEl(root: HTMLElement, id: string | null): HTMLElement | null {
    if (!id) return null;
    return root.querySelector<HTMLElement>(`[data-chat-prompt-id="${CSS.escape(id)}"]`);
}

/** Text nodes of `root` after `from` (exclusive) and before `to` (exclusive). */
function textNodesBetween(root: HTMLElement, from: Element | null, to: Element | null): Text[] {
    const out: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (from && !(from.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        if (from && from.contains(n)) continue;
        if (to && (to.contains(n) || !(to.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING))) continue;
        if (n.nodeValue && n.nodeValue.trim()) out.push(n as Text);
    }
    return out;
}

export function locateJumpTarget(
    root: HTMLElement,
    chronological: readonly Message[],
    targetId: string,
    req: ChatJumpRequest,
): { el: HTMLElement; scope: Text[] } | null {
    // B-766: an agent message with its own anchor is landed on directly.
    const direct = root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(targetId)}"]`);
    if (direct) return { el: direct, scope: [] };
    const promptId = promptForMessage(chronological, targetId);
    const prompt = promptEl(root, promptId);
    const prompts = [...root.querySelectorAll<HTMLElement>('[data-chat-prompt-id]')];
    const next = prompt ? prompts[prompts.indexOf(prompt) + 1] ?? null : null;
    if (promptId === targetId && prompt) {
        return { el: prompt, scope: textNodesBetween(root, null, null).filter((n) => prompt.contains(n)) };
    }
    const scope = textNodesBetween(root, prompt, next);
    const needle = req.snippet ? snippetNeedle(req.snippet, req.terms) : '';
    const byNeedle = needle ? scope.find((n) => normalizeForMatch(n.nodeValue ?? '').includes(needle)) : undefined;
    const byTerm = byNeedle ?? scope.find((n) => req.terms.some((t) => (n.nodeValue ?? '').toLowerCase().includes(t)));
    const el = byTerm?.parentElement ?? prompt;
    return el ? { el, scope: prompt ? [...textNodesBetween(root, null, null).filter((n) => prompt.contains(n)), ...scope] : scope } : null;
}

function paintHighlights(nodes: readonly Text[], terms: readonly string[]): () => void {
    const hl = highlightRegistry();
    if (!hl || terms.length === 0) return () => {};
    const ranges: Range[] = [];
    for (const node of nodes) {
        const lower = (node.nodeValue ?? '').toLowerCase();
        for (const term of terms) {
            let at = lower.indexOf(term);
            while (at >= 0 && ranges.length < MAX_HIGHLIGHT_RANGES) {
                const r = document.createRange();
                r.setStart(node, at);
                r.setEnd(node, at + term.length);
                ranges.push(r);
                at = lower.indexOf(term, at + term.length);
            }
        }
    }
    if (ranges.length === 0) return () => {};
    hl.registry.set(HIGHLIGHT_NAME, new hl.Ctor(...ranges));
    return () => hl.registry.delete(HIGHLIGHT_NAME);
}

/** B-766: restartable tint on the landed element (`.chat-jump-flash`, chatReadingAids.css). */
function flashElement(el: HTMLElement): void {
    el.classList.remove(FLASH_CLASS);
    void el.offsetWidth;
    el.classList.add(FLASH_CLASS);
    el.addEventListener('animationend', () => el.classList.remove(FLASH_CLASS), { once: true });
}

export function useChatJump(opts: {
    sessionId: string;
    scrollRef: RefObject<HTMLDivElement | null>;
    chronological: readonly Message[];
    isLoaded: boolean;
    hasMoreOlder: boolean;
    isLoadingOlder: boolean;
    /** Leave the live end so the follow logic does not snap back to the bottom. */
    onDetach: () => void;
}): void {
    const { sessionId, scrollRef, chronological, isLoaded, hasMoreOlder, isLoadingOlder } = opts;
    const [tick, setTick] = useState(0);
    const pagesRef = useRef(0);
    const detachRef = useRef(opts.onDetach);
    detachRef.current = opts.onDetach;
    const clearRef = useRef<() => void>(() => {});

    useEffect(() => onChatJumpRequest(sessionId, () => { pagesRef.current = 0; setTick((n) => n + 1); }), [sessionId]);
    useEffect(() => () => clearRef.current(), [sessionId]);

    useEffect(() => {
        const req = peekChatJump(sessionId);
        if (!req || !isLoaded) return;
        const target = findJumpMessage(chronological, req);
        if (!target) {
            if (isLoadingOlder) return;
            if (hasMoreOlder && pagesRef.current < MAX_JUMP_OLDER_PAGES) {
                pagesRef.current += 1;
                void sync.loadOlderMessages(sessionId);
                return;
            }
            // Not in the loaded history (or pruned from the transcript): the session stays where it opened.
            finishChatJump(sessionId, req);
            return;
        }
        let cancelled = false;
        const timers: ReturnType<typeof setTimeout>[] = [];
        const run = (attempt: number) => {
            if (cancelled) return;
            const root = scrollRef.current;
            const found = root ? locateJumpTarget(root, chronological, target, req) : null;
            if (!found) {
                if (attempt < LOCATE_ATTEMPTS) timers.push(setTimeout(() => run(attempt + 1), LOCATE_RETRY_MS));
                else finishChatJump(sessionId, req);
                return;
            }
            finishChatJump(sessionId, req);
            const land = () => { if (found.el.isConnected) found.el.scrollIntoView({ block: 'center' }); };
            detachRef.current();
            land();
            // The open-at-bottom pass and late layout (images, code blocks) can move it; re-assert twice.
            timers.push(setTimeout(land, 250), setTimeout(land, 700));
            if (req.flash) flashElement(found.el);
            clearRef.current();
            const clear = paintHighlights(found.scope, req.terms);
            const t = setTimeout(clear, HIGHLIGHT_MS);
            clearRef.current = () => { clearTimeout(t); clear(); };
        };
        const raf = requestAnimationFrame(() => run(0));
        return () => {
            cancelled = true;
            cancelAnimationFrame(raf);
            timers.forEach(clearTimeout);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, tick, chronological, isLoaded, hasMoreOlder, isLoadingOlder]);
}
