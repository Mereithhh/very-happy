/**
 * B-970b wiring guard: B-679 offline-exit replay for ACP runners (pi, gemini,
 * dsh). A message typed while the session was offline sat above the seeded
 * cursor and was never routed after a resume — and the undelivered-queue scan
 * tombstoned it. Decisions: `applyReconnectReplay` / `exitCursorStamp`
 * (utils/reconnectSession tests); exit behaviour: runAcp.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, './runAcp.ts'), 'utf8');
const section = (from: string, to: string) => {
    const start = source.indexOf(from);
    expect(start, from).toBeGreaterThan(-1);
    const end = source.indexOf(to, start);
    expect(end, to).toBeGreaterThan(start);
    return source.slice(start, end);
};

describe('ACP offline-exit replay wiring (B-970b)', () => {
    it('a seeded reconnect starts the cursor at the exit stamp, before the session client is built', () => {
        const seed = section('response = applyServerSnapshot(response, snapshot.session);', '} else {');
        expect(seed).toContain('const wake = applyReconnectReplay(response);');
        expect(seed).toContain('response = wake.response;');
        expect(seed).toContain('reconnectReplay = wake.replay;');
        expect(source.indexOf('const wake = applyReconnectReplay(response);')).toBeLessThan(source.indexOf('sessionClientOptions: reconnectSeeded && response ? { initialSeq: response.seq }'));
    });

    it('the undelivered scan never tombstones what is being replayed', () => {
        const reconnect = section('session.suppressNextArchiveSignal();', 'mergeReconnectMetadata(meta, metadata');
        expect(reconnect).toContain("if (reconnectReplay?.source !== 'hibernation') void session.cancelUndeliveredQueuedInputs(reconnectReplay ? { maxSeq: reconnectReplay.seq } : undefined);");
    });

    it('only an offline exit stamps the cursor and freezes inbound', () => {
        const begin = section('const beginExit = ', 'const stopRunnerFromBackendStatus');
        expect(begin).toContain("if (intent === 'offline' && session) {");
        expect(begin).toContain('exitCursor = exitCursorStamp(session.messageCursor, Date.now());');
        expect(begin).toContain('session.freezeInbound();');
    });
});
