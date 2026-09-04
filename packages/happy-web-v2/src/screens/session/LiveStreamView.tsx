/**
 * LiveStreamView — what the agent is generating RIGHT NOW (B-309).
 *
 * Sits at the tail of the transcript, above the status bar, and shows the
 * draft blocks relayed on the live stream channel. It is not part of the
 * message list: nothing here has an id, a seq, or a place in history, and a
 * reload wipes it. The moment the persisted message carrying the same
 * `streamKey` lands, storage claims the draft and this component drops the
 * block in the same commit — so the text does not blink out and back in.
 *
 * Thinking drafts render expanded and unadorned, the way the terminal shows
 * them, because the whole point is watching the reasoning arrive. Once the
 * real message lands it collapses into the usual "Thought for Ns" block.
 */
import { memo } from 'react';
import { Brain } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { useLiveStream } from '@/sync/liveStreamStore';
import { useSession } from '@/sync/storage';
import { isAgentWorkLive } from '@/sync/agentLiveness';
import type { LiveStreamBlock } from '@/sync/liveStream';
import { Markdown, NoPathLinks } from './Markdown';
import './livestream.css';
import { useHeartbeatFresh } from '@/sync/heartbeatLease';

/**
 * Presentational half — takes the blocks directly so it can be rendered (and
 * asserted on) without a live store. zustand's SSR snapshot is the INITIAL
 * state, so a store-reading component renders empty under
 * `renderToStaticMarkup`; keeping the markup in a pure component is what makes
 * this testable at all.
 */
export const LiveStreamBlocks = memo(function LiveStreamBlocks({ blocks: allBlocks }: { blocks: readonly LiveStreamBlock[] }) {
    const { t } = useTranslation();
    const blocks = allBlocks.filter((block) => block.text.length > 0);
    if (blocks.length === 0) return null;

    return (
        // No aria-live: this subtree is replaced ~12 times a second while text
        // streams, which would either flood a screen reader with re-readings of
        // the whole answer or (with aria-busy, which never gets to flip false
        // here) silence it entirely. The persisted message that replaces this
        // draft is what gets announced.
        <div className="ls">
            {/* Path links are pointless on a draft: findPathHits would run over
                every leaf ~12 times a second, and the persisted message links
                the same paths 1.5s later anyway. */}
            <NoPathLinks>
            {blocks.map((block, index) => {
                // Only the last unfinished block is still receiving text, so it
                // is the only one that gets a cursor.
                const streaming = !block.done && index === blocks.length - 1;
                if (block.kind === 'thinking') {
                    return (
                        <div key={block.key} className="msg msg--agent">
                            <div className="msg-thinking ls-thinking">
                                <div className="msg-thinking-head ls-thinking-head">
                                    <Brain size={13} className="msg-thinking-icon" aria-hidden />
                                    <span>{t('session.chat.thinkingLabel')}</span>
                                </div>
                                <div className="msg-thinking-body">
                                    <Markdown text={block.text} plainCode streaming />
                                    {streaming && <span className="ls-cursor" aria-hidden />}
                                </div>
                            </div>
                        </div>
                    );
                }
                return (
                    <div key={block.key} className="msg msg--agent">
                        <div className="msg-agent-text ls-text">
                            <Markdown text={block.text} plainCode streaming />
                            {streaming && <span className="ls-cursor" aria-hidden />}
                        </div>
                    </div>
                );
            })}
            </NoPathLinks>
        </div>
    );
});

export const LiveStreamView = memo(function LiveStreamView({ sessionId }: { sessionId: string }) {
    const stream = useLiveStream(sessionId);
    const session = useSession(sessionId);
    // B-322: thinking 是租约不是闩锁（sync/heartbeatLease.ts）。
    const leaseFresh = useHeartbeatFresh(sessionId);
    const live = isAgentWorkLive({
        presence: session?.presence,
        thinking: session?.thinking,
        runningSubagentsInTurn: 0,
        heartbeatFresh: leaseFresh,
    });
    // A draft belongs to a turn that is either running, or just finished and
    // still waiting for its persisted message (the armed sweep). Anything else
    // — a session that went quiet, or frames from a producer that is not
    // actually driving a turn — must not paint into the transcript, where a
    // draft is visually indistinguishable from a real reply.
    if (!live && stream.sweepAt === null) return null;
    return <LiveStreamBlocks blocks={stream.blocks} />;
});
