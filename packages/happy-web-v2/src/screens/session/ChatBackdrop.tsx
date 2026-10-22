/**
 * B-752 — the conversation's ASCII backdrop: the default page's field
 * (B-720 AsciiField) at the calm `chat` preset, fixed behind the transcript.
 * The text is the subject, so the field is paced down whenever the page is
 * busy: paused while anything inside the chat body scrolls (reader or
 * auto-follow), ≤ 8 fps while the agent is working, the preset rate at rest.
 * Settings → Appearance → 背景动效 off renders nothing and listens to nothing.
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

export function ChatBackdrop({ sessionId }: { sessionId: string }) {
    const [enabled] = useAsciiMotion();
    if (!enabled) return null;
    return <ChatBackdropField sessionId={sessionId} />;
}

function ChatBackdropField({ sessionId }: { sessionId: string }) {
    const ref = useRef<HTMLDivElement>(null);
    const [scrolling, setScrolling] = useState(false);
    const session = useSession(sessionId);
    const heartbeatFresh = useHeartbeatFresh(sessionId);
    // Sub-agent-only work is left out: it streams into its own panel, not this transcript.
    const streaming = isAgentWorkLive({ presence: session?.presence, thinking: session?.thinking, runningSubagentsInTurn: 0, heartbeatFresh });

    useEffect(() => {
        const root = ref.current?.parentElement;
        if (!root) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onScroll = () => {
            if (timer === undefined) setScrolling(true);
            else clearTimeout(timer);
            timer = setTimeout(() => { timer = undefined; setScrolling(false); }, SCROLL_IDLE_MS);
        };
        // scroll does not bubble; capture sees every scroller inside the chat body.
        root.addEventListener('scroll', onScroll, { capture: true, passive: true });
        return () => {
            root.removeEventListener('scroll', onScroll, { capture: true });
            if (timer !== undefined) clearTimeout(timer);
        };
    }, []);

    return (
        <div ref={ref} className="sd-backdrop" aria-hidden="true">
            <AsciiField preset="chat" pace={backdropPace({ scrolling, streaming })} />
        </div>
    );
}
