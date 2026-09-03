import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B-309 wiring assertions on the web side. The fold logic is covered by
 * liveStream.test.ts; these pin the three connections that would otherwise
 * fail silently — a draft that never arrives, a draft that never leaves, and
 * a status bar with no numbers.
 */
const read = (relative: string) => readFileSync(join(__dirname, relative), 'utf8');

describe('web live stream wiring', () => {
    it('sync subscribes to the relayed frames', () => {
        const source = read('./sync.ts');
        expect(source).toContain("apiSocket.onMessage('session-stream'");
        expect(source).toContain('void handleSessionStream(this.encryption, data)');
    });

    it('storage claims drafts BEFORE the reducer runs', () => {
        const source = read('./storage.ts');
        const claim = source.indexOf('claimLiveStreamKeys(sessionId, streamKeysOf(messages))');
        const reduce = source.indexOf('reducer(existingSession.reducerState, normalizedMessages, agentState)');
        expect(claim).toBeGreaterThan(-1);
        expect(reduce).toBeGreaterThan(-1);
        // Claiming after would leave one frame showing both the draft and the
        // message that replaces it.
        expect(claim).toBeLessThan(reduce);
    });

    it('the transcript mounts the draft view', () => {
        const source = readFileSync(join(__dirname, '../screens/session/ChatList.tsx'), 'utf8');
        expect(source).toContain('<LiveStreamView sessionId={sessionId} />');
    });

    it('the status bar reads live progress rather than only the heartbeat', () => {
        const source = readFileSync(join(__dirname, '../screens/session/SessionLiveStatusBar.tsx'), 'utf8');
        // Subscribes to the PROGRESS slice, not the whole stream: the full
        // state's `updatedAt` moves on every one of ~12 frames/second, which
        // would re-render the bar at that rate for no visible change.
        expect(source).toContain('useLiveStreamProgress(sessionId)');
        expect(source).not.toContain('useLiveStream(sessionId)');
        expect(source).toContain('thinkingTokens: progress.thinkingTokens');
        expect(source).toContain('outputTokens: progress.outputTokens');
    });
});

describe('draft sweep safety net', () => {
    it('a session that stops being live arms the DELAYED sweep, never an immediate clear', () => {
        const source = readFileSync(join(__dirname, '../screens/session/ChatList.tsx'), 'utf8');
        expect(source).toContain('if (!sessionLive) endLiveStreamTurn(sessionId)');
        // Clearing outright here would blank the transcript's tail for the
        // whole trip the persisted message is still making.
        expect(source).not.toContain('clearLiveStream');
    });
});

describe('draft is gated on the turn being real', () => {
    it('renders nothing for a session that is neither live nor waiting on its persisted message', () => {
        const source = readFileSync(join(__dirname, '../screens/session/LiveStreamView.tsx'), 'utf8');
        // A draft is visually indistinguishable from a real reply, so frames
        // from anything that is not actually driving a turn must not paint.
        expect(source).toContain('if (!live && stream.sweepAt === null) return null;');
        expect(source).toContain('isAgentWorkLive({');
    });

    it('does not put an aria-live region around text that changes 12 times a second', () => {
        const source = readFileSync(join(__dirname, '../screens/session/LiveStreamView.tsx'), 'utf8');
        // Attribute, not the word — the comment above it explains why.
        expect(source).not.toMatch(/aria-live=/);
        expect(source).not.toMatch(/aria-busy=/);
    });
});
