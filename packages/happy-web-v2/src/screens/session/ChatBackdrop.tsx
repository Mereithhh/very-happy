/**
 * B-752 — the conversation's ASCII backdrop: the default page's field
 * (B-720 AsciiField) at the calm `chat` preset, fixed behind the transcript.
 * The text is the subject, so the field is paced down whenever the page is
 * busy: paused while anything inside the chat body scrolls (reader or
 * auto-follow), ≤ 8 fps while the agent is working, the preset rate at rest.
 * Settings → Appearance → 背景动效 off renders nothing and listens to nothing.
 *
 * Placement is about compositor cost as much as calm: an animated layer
 * repaints its whole box every frame, so with room beside the 820px message
 * column the field is two unmasked side strips (the column itself stays
 * plain, nothing animates behind the text). Only when there are no margins
 * (phones, a narrow pane) does one full field run, at half strength
 * (`--ascii-gain`), never a CSS mask (a mask needs an extra offscreen pass).
 */
import { useEffect, useRef, useState } from 'react';
import { AsciiField } from '@/ui/asciiField/AsciiField';
import { backdropPace } from '@/ui/asciiField/asciiFieldModel';
import { useAsciiMotion } from '@/ui/asciiField/asciiMotionPreference';
import { useSession } from '@/sync/storage';
import { isAgentWorkLive } from '@/sync/agentLiveness';
import { useHeartbeatFresh } from '@/sync/heartbeatLease';

/** Quiet time after the last scroll event before the field moves again. */
export const SCROLL_IDLE_MS = 500;
/** The transcript lane (`.cl-inner`: min(820px, 100%)). */
export const CHAT_COLUMN_PX = 820;
/** Narrowest side margin worth a field of its own. */
export const MIN_SIDE_PX = 120;
/** World offset of the right strip so it does not mirror the left one. */
const RIGHT_ORIGIN_PX = 4096;

export type BackdropLayout = 'sides' | 'full';
export function backdropLayout(width: number): BackdropLayout {
    return width >= CHAT_COLUMN_PX + 2 * MIN_SIDE_PX ? 'sides' : 'full';
}

export function ChatBackdrop({ sessionId }: { sessionId: string }) {
    const [enabled] = useAsciiMotion();
    if (!enabled) return null;
    return <ChatBackdropField sessionId={sessionId} />;
}

function ChatBackdropField({ sessionId }: { sessionId: string }) {
    const ref = useRef<HTMLDivElement>(null);
    const [scrolling, setScrolling] = useState(false);
    const [layout, setLayout] = useState<BackdropLayout | null>(null);
    const session = useSession(sessionId);
    const heartbeatFresh = useHeartbeatFresh(sessionId);
    // Sub-agent-only work is left out: it streams into its own panel, not this transcript.
    const streaming = isAgentWorkLive({ presence: session?.presence, thinking: session?.thinking, runningSubagentsInTurn: 0, heartbeatFresh });

    useEffect(() => {
        const el = ref.current;
        const root = el?.parentElement;
        if (!el || !root) return;
        // Re-renders only when the layout flips, not on every resize.
        const measure = () => setLayout(backdropLayout(el.clientWidth));
        measure();
        const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
        ro?.observe(el);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onScroll = () => {
            if (timer === undefined) setScrolling(true);
            else clearTimeout(timer);
            timer = setTimeout(() => { timer = undefined; setScrolling(false); }, SCROLL_IDLE_MS);
        };
        // scroll does not bubble; capture sees every scroller inside the chat body.
        root.addEventListener('scroll', onScroll, { capture: true, passive: true });
        return () => {
            ro?.disconnect();
            root.removeEventListener('scroll', onScroll, { capture: true });
            if (timer !== undefined) clearTimeout(timer);
        };
    }, []);

    const pace = backdropPace({ scrolling, streaming });
    return (
        <div ref={ref} className={`sd-backdrop${layout ? ` sd-backdrop--${layout}` : ''}`} aria-hidden="true">
            {layout === 'sides' && <>
                <AsciiField preset="chat" pace={pace} className="sd-backdrop__side sd-backdrop__side--start" />
                <AsciiField preset="chat" pace={pace} originX={RIGHT_ORIGIN_PX} className="sd-backdrop__side sd-backdrop__side--end" />
            </>}
            {layout === 'full' && <AsciiField preset="chat" pace={pace} />}
        </div>
    );
}
