import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B-309 wiring assertions. The aggregator's own behaviour is covered by
 * streamRelay.test.ts; what cannot fail loudly on its own is the WIRING —
 * every one of these was absent before B-309, and each absence alone is enough
 * to put the web back to a spinner with nothing behind it.
 */
const read = (relative: string) => readFileSync(join(__dirname, relative), 'utf8');

describe('claudeRemote streaming wiring', () => {
    const source = read('./claudeRemote.ts');

    it('asks the SDK for partials — without this there are no deltas to relay at all', () => {
        expect(source).toContain('includePartialMessages: opts.onStreamFrame ? true : undefined');
    });

    it('diverts stream_event away from onMessage', () => {
        // Letting it continue would push ~100 frames/second through the
        // ordering queue the real messages depend on, only to be dropped by
        // the converter at the end.
        expect(source).toContain("if (message.type === 'stream_event')");
        expect(source).toContain("opts.onStreamFrame({ type: 'stream_event', event: (message as { event: unknown }).event })");
    });

    it('forwards the progress-bearing system frames the persisted path drops', () => {
        expect(source).toContain("subtype: 'thinking_tokens'");
        expect(source).toContain("subtype: 'status'");
    });

    it('splits stream_event ABOVE the per-message debug log', () => {
        // ~100 frames/second, and the log line stringifies the whole message
        // then writes to disk synchronously.
        const split = source.indexOf("if (message.type === 'stream_event')");
        const log = source.indexOf('logger.debug(`[claudeRemote] Message ${message.type}`');
        expect(split).toBeGreaterThan(-1);
        expect(log).toBeGreaterThan(-1);
        expect(split).toBeLessThan(log);
    });

    it('honours an off switch so a machine can stop producing drafts', () => {
        const launcher = read('./claudeRemoteLauncher.ts');
        expect(launcher).toContain("process.env.HAPPY_SESSION_STREAM_DISABLED !== '1'");
        expect(launcher).toContain('onStreamFrame: streamingEnabled ?');
    });
});

describe('claudeRemoteLauncher streaming wiring', () => {
    const source = read('./claudeRemoteLauncher.ts');

    it('feeds the relay and sends its frames through the session client', () => {
        expect(source).toContain('new StreamRelay({');
        expect(source).toContain('session.client.sendStreamFrame(frame)');
        expect(source).toContain('streamRelay.ingest(frame)');
    });

    it('sweeps only AFTER the turn\'s messages have left the queue', () => {
        // `turn-end` starts a 1.5s countdown on the web, and this bypass
        // already outruns the queue that holds tool_use frames for 250ms.
        // Arming it first could blank the transcript tail before they land.
        const flush = source.indexOf('await messageQueue.flush()');
        const sweep = source.indexOf('streamRelay.endTurn()');
        expect(flush).toBeGreaterThan(-1);
        expect(sweep).toBeGreaterThan(flush);
    });
});

describe('apiSession stream relay', () => {
    const source = read('../api/apiSession.ts');

    it('encrypts the frame with the session key and relays it volatile', () => {
        // Encrypted for the same reason clipboard and file-preview are: the
        // relay must never be able to read thinking text.
        expect(source).toContain("this.socket.volatile.emit('session-stream'");
        // The object, not a JSON string — `encrypt` serializes internally and
        // double-encoding escapes every quote in the streamed text.
        expect(source).toContain('encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, frame))');
    });
});

describe('sub-agent isolation', () => {
    const source = read('./claudeRemote.ts');

    it('never feeds a sub-agent’s partials into the main draft', () => {
        // Interleaving another agent's sentences into the answer being written
        // would be worse than showing nothing.
        expect(source).toContain('!(message as { parent_tool_use_id?: string | null }).parent_tool_use_id');
    });
});
