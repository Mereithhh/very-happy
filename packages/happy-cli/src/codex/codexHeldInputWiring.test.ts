/**
 * B-854 wiring guard: a Codex message taken off the queue ends as run (Codex
 * accepted its turn), or as a `queue-cancel` tombstone — never silently with
 * the error line (D1) or with the process (D2). The decision is `HeldInput`
 * (utils/heldInput.test.ts) and `onTurnStarted` (codexAppServerClient.test.ts);
 * this pins where runCodex calls them. Pinned with scripts/dev/mutation-check.mjs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, './runCodex.ts'), 'utf8');
const section = (from: string, to: string) => {
    const start = source.indexOf(from);
    expect(start, from).toBeGreaterThan(-1);
    const end = source.indexOf(to, start);
    expect(end, to).toBeGreaterThan(start);
    return source.slice(start, end);
};

describe('Codex held input wiring (B-854)', () => {
    it('holds the dequeued batch and releases it only when Codex took the turn', () => {
        expect(source).toContain('message = batch;\n                heldInput.hold(batch.sourceIds);');
        expect(source).toMatch(/onTurnStarted: \(\) => \{\n\s*lastStartedEffort = turnEffort\.effort;\n\s*heldInput\.delivered\(\);\n\s*\},/);
        // /clear is handled here; /compact once app-server is back.
        expect(section("logger.debug('[Codex] Handling /clear command", 'client.clearThreadState();')).toContain('heldInput.delivered();');
        expect(source).toContain('await client.ensureConnected();\n                    heldInput.delivered();\n                    const outcome = await runCodexCompact(');
    });

    it('D1: a pre-flight failure tombstones the batch as failed', () => {
        const caught = section("logger.warn('Error in codex session'", 'const reason = describeThrownTurnError(error);');
        expect(caught).toContain("heldInput.drop('failed')");
    });

    it('D2: kill / signal tombstone the held batch and the queue before the final flush, and stop a late turn', () => {
        // Before the abort: the daemon SIGKILLs 2 s after its SIGTERM.
        const kill = section('const handleKillSession = async', "await handleAbort('kill');");
        expect(kill).toContain("const exitReason = intent === 'archive' ? 'aborted' : 'restarted';");
        expect(kill).toContain('terminating = true;');
        expect(kill).toContain('heldInput.drop(exitReason);');
        expect(kill).toContain('messageQueue.discardAll(exitReason);');
        const beforeTurn = section('const staged = message.attachments?.length', 'const result = await client.sendTurnAndWait(');
        expect(beforeTurn).toContain('if (terminating) {');
    });

    it('leaving the loop reports what is left; a message that could not be prepared is marked too', () => {
        const cleanup = section('session.closePromptQueueDrain(); // B-509', "logger.debug('[codex]: Final cleanup start');");
        expect(cleanup).toContain("heldInput.drop('aborted');");
        expect(cleanup).toContain("messageQueue.discardAll('aborted');");
        const prepare = section("logger.warn('[Codex] Failed to prepare user attachments'", 'let thinking = false;');
        expect(prepare).toContain("if (message.localKey) session.sendQueueCancelReason([message.localKey], 'failed');");
    });
});
