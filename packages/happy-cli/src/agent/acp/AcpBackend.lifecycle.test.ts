/**
 * B-629: the agent process is part of the turn. Driven against a real child process
 * (`__fixtures__/fakeAcpAgent.mjs`, a minimal ACP agent over stdio) because the failure
 * being fixed lives in the SDK's stream handling: when the agent dies, `prompt()` used to
 * hang forever and nothing said why.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { AcpBackend, isAgentExitError } from './AcpBackend';

const fixture = fileURLToPath(new URL('./__fixtures__/fakeAcpAgent.mjs', import.meta.url));

function backendFor(scenario: string, env: Record<string, string> = {}) {
    const backend = new AcpBackend({
        agentName: 'pi',
        cwd: process.cwd(),
        command: process.execPath,
        args: [fixture, scenario],
        env,
    });
    const messages: Array<Record<string, unknown>> = [];
    backend.onMessage((message) => { messages.push(message as Record<string, unknown>); });
    return { backend, messages };
}

const backends: AcpBackend[] = [];
afterEach(async () => {
    for (const backend of backends.splice(0)) await backend.dispose();
});

describe('AcpBackend lifecycle (B-629)', () => {
    it('ends the turn when the prompt is answered, even with a tool call still open', async () => {
        const { backend, messages } = backendFor('end-turn');
        backends.push(backend);
        const { sessionId } = await backend.startSession();
        const outcome = await backend.sendPrompt(sessionId, 'go');
        expect(outcome).toEqual({ stopReason: 'end_turn' });
        // No 120 s wait for the text to go quiet: the response is the end.
        await backend.waitForResponseComplete?.(50);
        const statuses = messages.filter((m) => m.type === 'status').map((m) => m.status);
        expect(statuses[statuses.length - 1]).toBe('idle');
        expect(messages.some((m) => m.type === 'model-output' && m.textDelta === 'working on it')).toBe(true);
        expect(backend.hasExited).toBe(false);
    });

    it('rejects the prompt in flight with the exit code and stderr tail when the agent dies, and announces it', async () => {
        const { backend, messages } = backendFor('die-mid-prompt');
        backends.push(backend);
        const { sessionId } = await backend.startSession();
        let caught: unknown;
        try {
            await backend.sendPrompt(sessionId, 'go');
        } catch (error) {
            caught = error;
        }
        expect(isAgentExitError(caught)).toBe(true);
        if (!isAgentExitError(caught)) return;
        expect(caught.agentExitCode).toBe(3);
        expect(caught.message).toMatch(/^pi process exited \(code=3\): FATAL ERROR: Reached heap limit Allocation failed$/);
        expect(backend.stderrTail()).toContain('Reached heap limit');
        expect(backend.hasExited).toBe(true);
        const stopped = messages.find((m) => m.type === 'status' && m.status === 'stopped');
        expect(stopped?.detail).toContain('code=3');
        // A dead backend refuses the next prompt at once instead of hanging on it.
        await expect(backend.sendPrompt(sessionId, 'again')).rejects.toSatisfy((error: unknown) => isAgentExitError(error));
    });

    it('announces an exit with code 0 too (it used to be silent)', async () => {
        const { backend, messages } = backendFor('exit-zero-idle');
        backends.push(backend);
        await backend.startSession();
        await new Promise((resolve) => setTimeout(resolve, 150));
        const stopped = messages.find((m) => m.type === 'status' && m.status === 'stopped');
        expect(stopped?.detail).toMatch(/^pi process exited \(code=0\)$/);
        expect(backend.hasExited).toBe(true);
    });

    it('fails the prompt whose answer is an oversized frame instead of waiting for it forever', async () => {
        const { backend } = backendFor('oversized', { FAKE_ACP_OVERSIZE_CHARS: String(17 * 1024 * 1024) });
        backends.push(backend);
        const { sessionId } = await backend.startSession();
        await expect(backend.sendPrompt(sessionId, 'go')).rejects.toThrow(/oversized|cannot be read/);
    }, 30_000);
});
