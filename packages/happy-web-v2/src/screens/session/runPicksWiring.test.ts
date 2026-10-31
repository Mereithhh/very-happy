/**
 * B-849b wiring in AgentInput.tsx: the composer reads the session's own choice
 * (sync/runPicks.ts — its behavior has executable tests), records the base a
 * pick replaces before storing it, pushes the pick to the wrapper, tidies an
 * echoed / superseded local pick, and stores an explicit 「自动」 as a choice.
 * Source assertions, verified with scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./AgentInput.tsx', import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\n(?:[ \t]*\n)+/g, '\n');
const between = (start: string, end: string) => {
    const at = source.indexOf(start);
    expect(at).toBeGreaterThan(-1);
    return source.slice(at, source.indexOf(end, at));
};

describe('AgentInput run picks (B-849b)', () => {
    it('model and effort shown are the session\'s own choice, not the device-local value', () => {
        expect(source).toContain('const runSession = session ? withRunPicks(session) : null;');
        expect(source).toContain('const explicitModelMode = pending?.modelMode ?? runSession?.modelMode;');
        expect(source).toContain('const effortKey = (pending ? pending.effortLevel : runSession?.effortLevel) ?? agentDefaults.effortLevel;');
        expect(source).toContain('pending ? pending.effortLevel : runSession?.effortLevel,');
    });
    it('a pick records its base before the store changes, then goes to the wrapper', () => {
        const set = between('const setMode = (', 'const pushPick = async');
        const base = set.indexOf("setRunPickBase(sessionId, field === 'modelMode' ? 'model' : 'effort', sessionRunIntents(metadata)[field === 'modelMode' ? 'model' : 'effort']);");
        expect(base).toBeGreaterThan(-1);
        expect(base).toBeLessThan(set.indexOf('storage.getState()[fn](sessionId, key);'));
        expect(set).toContain("if (session && (field === 'modelMode' || field === 'effortLevel')) void pushPick(field, key);");
        const push = between('const pushPick = async', 'const modelIntent = metadata?.modelIntent;');
        expect(push).toContain('{ modelIntent: meta.modelIntent, model: meta.model ?? null }');
        expect(push).toContain('{ effortIntent: meta.effortIntent, effort: meta.effort ?? null }');
        expect(push).toContain('await pushRunIntent(current, params, (id, method, body) => apiSocket.sessionRPC(id, method, body));');
    });
    it('an echoed or superseded local pick is cleared with its base', () => {
        const settle = between('const modelIntent = metadata?.modelIntent;', '}, [sessionId, modelIntent, effortIntent');
        expect(settle).toContain("if (settledRunPick(current, 'model') === 'clear') {");
        expect(settle).toContain('storage.getState().updateSessionModelMode(sessionId, null);');
        expect(settle).toContain("setRunPickBase(sessionId, 'effort', undefined);");
    });
    it('「自动」 in a session is stored as a choice of its own', () => {
        expect(source).toContain("setMode('updateSessionEffortLevel', 'effortLevel', pending ? null : EFFORT_PICK_AUTO);");
    });
    it('Claude 「本机配置」 is pickable mid-session only where the wrapper switches back to settings', () => {
        expect(source).toContain('liveSwitch: metadata?.capabilities?.includes(CLAUDE_CONFIG_MODEL_CAPABILITY) === true');
    });
});
