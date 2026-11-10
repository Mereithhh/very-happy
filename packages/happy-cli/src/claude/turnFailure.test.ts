import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClaudeTurnFailureDetector } from './turnFailure';

/** The synthetic frame Claude Code ends a failed API call with (11-05 Lead transcript shape). */
const apiErrorFrame = (text: string, error = 'unknown') => ({
    type: 'assistant', parent_tool_use_id: null, error, uuid: 'u', session_id: 's',
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
});
const answer = (text: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }] } });
const ok = { type: 'result', subtype: 'success', is_error: false, result: 'done' };
const errResult = (text: string) => ({ type: 'result', subtype: 'success', is_error: true, result: text });

describe('B-913 Claude turn failure detector', () => {
    it('the 11-05 case: synthetic `API Error: 400` + is_error result → failure with the line and status', () => {
        const d = createClaudeTurnFailureDetector();
        const text = 'API Error: 400 Anthropic Claude bad request: advisor_20260301 requires request field model';
        d.observe(apiErrorFrame(text));
        expect(d.conclude(errResult(text), 7)).toEqual({ at: 7, summary: text, provider: 'claude', status: 400 });
    });

    it('the assistant frame alone decides (a runtime whose result says success)', () => {
        const d = createClaudeTurnFailureDetector();
        d.observe(apiErrorFrame('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'overloaded'));
        expect(d.conclude(ok, 1)).toMatchObject({ summary: 'API Error: 529: Overloaded', status: 529 });
    });

    it('also a turn ended by idle without a result frame', () => {
        const d = createClaudeTurnFailureDetector();
        d.observe(apiErrorFrame('API Error: 500 Internal server error', 'server_error'));
        expect(d.conclude(undefined, 1)).toMatchObject({ status: 500 });
    });

    it('an is_error / error_during_execution result without the frame still counts', () => {
        const d = createClaudeTurnFailureDetector();
        expect(d.conclude(errResult('API Error: Request timed out'), 1)).toMatchObject({ summary: 'API Error: Request timed out', status: null });
        expect(d.conclude({ subtype: 'error_during_execution', is_error: true, errors: ['stream closed'] }, 2)).toMatchObject({ summary: 'stream closed' });
    });

    it('not turn failures: success, sign-in problems (own card), limits the user set', () => {
        const d = createClaudeTurnFailureDetector();
        d.observe(answer('all good'));
        expect(d.conclude(ok)).toBeNull();
        d.observe(apiErrorFrame('Failed to authenticate. API Error: 401 OAuth session expired', 'authentication_failed'));
        expect(d.conclude(errResult('authentication_failed'))).toBeNull();
        expect(d.conclude(errResult('authentication_failed'))).toBeNull();
        expect(d.conclude({ subtype: 'error_max_turns', is_error: true })).toBeNull();
        expect(d.conclude({ subtype: 'error_max_budget_usd', is_error: true })).toBeNull();
    });

    it('a real answer after the error means the turn recovered; sub-agent frames do not count', () => {
        const d = createClaudeTurnFailureDetector();
        d.observe(apiErrorFrame('API Error: 529 Overloaded', 'overloaded'));
        d.observe(answer('here is the answer'));
        expect(d.conclude(ok)).toBeNull();
        d.observe({ ...apiErrorFrame('API Error: 400 x'), parent_tool_use_id: 'tu-1' });
        expect(d.conclude(ok)).toBeNull();
    });

    it('one verdict per turn: the next turn does not inherit the error', () => {
        const d = createClaudeTurnFailureDetector();
        d.observe(apiErrorFrame('API Error: 400 bad'));
        expect(d.conclude(errResult('API Error: 400 bad'))).not.toBeNull();
        // a task notification wakes the session; that turn only runs tools
        expect(d.conclude(ok)).toBeNull();
        d.observe(apiErrorFrame('API Error: 400 bad'));
        d.reset();
        expect(d.conclude(ok)).toBeNull();
    });
});

describe('B-913 runClaude declares the capability', () => {
    it('after the issue capability, on the metadata the session is created with', () => {
        const src = readFileSync(join(__dirname, 'runClaude.ts'), 'utf8');
        expect(src).toContain('metadata.capabilities = [...(metadata.capabilities ?? []), ISSUE_SESSION_CAPABILITY];\n    // B-913: this wrapper records model / API turn failures (agentState.turnFailure).\n    metadata.capabilities = [...metadata.capabilities, TURN_FAILURE_CAPABILITY];');
    });
});

describe('B-913 remote launcher wiring', () => {
    const src = readFileSync(join(__dirname, 'claudeRemoteLauncher.ts'), 'utf8');
    it('every pulled prompt starts a turn: failure cleared, background tasks get the turn', () => {
        expect(src).toContain('nextMessage: async () => startTurn(await (async () => {');
        const startTurn = src.slice(src.indexOf('const startTurn ='), src.indexOf('async function abort()'));
        expect(startTurn).toContain('turnFailures.reset();');
        expect(startTurn).toContain('session.client.clearTurnFailure();');
        expect(startTurn).toContain('backgroundTasks.beginTurn(');
        expect(src).toContain('turnFailures.observe(message);');
    });
    it('the verdict is taken at the turn end, after a user stop is ruled out, and pushes at most once (only when idle)', () => {
        const onReady = src.slice(src.indexOf('onReady: (result) => {'), src.indexOf('applyClaudeResultLifecycle(result, {'));
        expect(onReady.indexOf('turnSteering.consumeInterrupted()')).toBeLessThan(onReady.indexOf('turnFailures.conclude(result)'));
        expect(onReady).toContain('session.client.setTurnFailure(failure);');
        expect(onReady.match(/sendTurnFailedNotification\(/g)?.length).toBe(1);
        expect(onReady).toMatch(/if \(idle\) \{\s*session\.api\.push\(\)\.sendTurnFailedNotification/);
        expect(onReady).toContain('session.client.clearTurnFailure();');
    });
});
