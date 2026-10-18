/**
 * B-630: runGemini's turn lifecycle after the Orca comparison — the turn ends on the ACP
 * prompt answer (no 120 s wait), Stop withdraws open approvals, a failed turn is reported
 * once as a service line, the Gemini process dying restarts it on the next message, and
 * SIGTERM goes offline instead of archiving (AGENTS 7). Source assertions, verified with
 * scripts/dev/mutation-check.mjs; the error texts and the retry decision have their own
 * executable tests (turnFailure.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../runGemini.ts', import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\n(?:[ \t]*\n)+/g, '\n');

describe('runGemini wiring (B-630)', () => {
    it('ends the turn on the prompt answer and reads the stop reason', () => {
        expect(source).not.toContain('waitForResponseComplete');
        expect(source).toContain('const outcome = await geminiBackend.sendPrompt(acpSessionId, promptToSend);');
        expect(source).toContain("if (stopReason === 'cancelled') {\n              turnEnding = 'aborted';");
    });

    it('withdraws open approvals on Stop, before cancelling the prompt', () => {
        const at = source.indexOf('permissionHandler.abortAll();');
        expect(at).toBeGreaterThan(0);
        expect(at).toBeLessThan(source.indexOf('await geminiBackend.cancel(acpSessionId);'));
    });

    it('reports a failed turn once, as a service line, and never as task_complete', () => {
        expect(source).toContain("const failure = describeGeminiFailure(error, { model: displayedModel || 'gemini-2.5-pro' });");
        expect(source).toContain("session.sendSessionEvent({ type: 'message', message: failure.message });");
        expect(source).toContain("if (turnEnding === 'completed') {\n          session.sendAgentMessage('gemini', {\n            type: 'task_complete',");
        // The status handler no longer announces the same failure a second time.
        expect(source).not.toContain("if (msg.status === 'error') {\n          logger.debug('[gemini] Error status received:', contentLogMetadata(statusDetail));\n          session.sendAgentMessage");
    });

    it('shows retries on the web and starts each attempt with an empty answer', () => {
        const at = source.indexOf('for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {');
        expect(at).toBeGreaterThan(0);
        const loop = source.slice(at, at + 1800);
        expect(loop).toContain("accumulatedResponse = '';");
        expect(loop).toContain('if (isRetryableGeminiError(promptError) && attempt < MAX_RETRIES) {');
        expect(loop).toContain("session.sendSessionEvent({ type: 'message', message: notice });");
    });

    it('restarts Gemini on the next message after its process exited, re-seeding the conversation', () => {
        expect(source).toContain("if (msg.status === 'stopped') {\n          backendGone = new Error(statusDetail || 'gemini process exited');");
        expect(source).toContain('const restartAfterExit = backendGone !== null;');
        expect(source).toContain('if (restartAfterExit || (wasSessionCreated && currentModeHash && message.hash !== currentModeHash)) {');
        expect(source).toContain("if (failure.kind === 'exited' && error instanceof Error) {\n            backendGone = error;");
    });

    it('raises thinking at dequeue and goes offline (not archived) on a signal', () => {
        const at = source.indexOf('turnEnding = \'completed\';\n      let injectHistoryContext = false;');
        expect(at).toBeGreaterThan(0);
        expect(source.slice(at - 200, at)).toContain("thinking = true;\n        session.keepAlive(thinking, 'remote');");
        expect(source).toContain("registerKillSessionHandler(session.rpcHandlerManager, () => handleKillSession('archive'), session, { processSignals: true, onSignal: () => handleKillSession('offline') });");
        expect(source).toContain('await settleCodexSession(session, intent, (id) => api.deactivateSession(id)');
    });
});
