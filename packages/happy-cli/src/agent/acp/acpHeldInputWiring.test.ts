/**
 * B-854 wiring guard: an ACP/pi message ends as run (`session/prompt` sent),
 * still queued, or a `queue-cancel` tombstone — a pre-flight failure (A1) or a
 * kill / signal / backend stop (A2) used to drop it silently, and every exit
 * archived the session. Decisions: `HeldInput`, `MessageQueue2.discardAll`,
 * `acpExitIntent` (own tests). Pinned with scripts/dev/mutation-check.mjs.
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

describe('ACP held input wiring (B-854)', () => {
    it('queue discards become tombstones (ACP never wired setOnDiscard)', () => {
        const discard = section('messageQueue.setOnDiscard((entries) => {', '});');
        expect(discard).toContain('session.sendQueueCancelReason(keys, entries[0].reason);');
    });

    it('holds the batch from dequeue until the prompt is sent; never sends after a kill', () => {
        expect(source).toContain('heldInput.hold(batch.sourceIds);');
        const beforePrompt = section('const staged = attachments.length', 'promptInFlight = true;');
        expect(beforePrompt.indexOf('if (shouldExit) {')).toBeGreaterThan(-1);
        expect(beforePrompt.indexOf('if (shouldExit) {')).toBeLessThan(beforePrompt.indexOf('heldInput.delivered();'));
    });

    it('A1: a pre-flight failure tombstones the batch as failed', () => {
        const caught = section('const failure = describeAcpTurnFailure(opts.agentName, error);', 'sendEnvelopes(sessionManager.endTurn(');
        expect(caught).toContain("heldInput.drop('failed');");
    });

    it('A2: kill archives with aborted, a signal goes offline with restarted, a dead backend offline with failed', () => {
        const kill = section('const disposeTermination = registerKillSessionHandler(', 'B-629: a fresh agent process');
        expect(kill).toContain("beginExit('archive', 'aborted');");
        expect(kill).toContain("onSignal: async () => {\n      beginExit('offline', 'restarted');");
        expect(section('const stopRunnerFromBackendStatus', 'const sendEnvelopes')).toContain("beginExit('offline', 'failed');");
        const begin = section('const beginExit = ', 'const stopRunnerFromBackendStatus');
        expect(begin).toContain('heldInput.drop(exit.reason);');
        expect(begin).toContain('messageQueue.discardAll(exit.reason);');
    });

    it('only an archive intent stamps archived; offline deactivates', () => {
        const close = section('session.closePromptQueueDrain(); // B-509', 'await session.close();');
        expect(close).toContain("heldInput.drop(exit?.reason ?? 'failed');");
        expect(close).toContain("messageQueue.discardAll(exit?.reason ?? 'failed');");
        expect(close).toContain("if (intent === 'archive') {\n        session.updateMetadata(");
        expect(close).toContain("if (intent === 'offline') {");
        expect(close).toContain('await api.deactivateSession(session.sessionId)');
    });
});
