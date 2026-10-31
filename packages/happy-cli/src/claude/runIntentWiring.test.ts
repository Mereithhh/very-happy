/**
 * B-849b wiring: Claude / Codex wrappers record the session's run intent, answer
 * the session-run-intent RPC, restore it on resume and keep it across abort;
 * Claude reports what it really runs and switches 「本机配置」 to the settings
 * model. Pure parts have their own tests (happy-wire runIntent, utils/runIntent,
 * claudeRunFacts). Source assertions, verified with scripts/dev/mutation-check.mjs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CLAUDE_CONFIG_MODEL_CAPABILITY, RUN_INTENT_CAPABILITY, RUN_INTENT_RPC } from '@slopus/happy-wire';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\n(?:[ \t]*\n)+/g, '\n');
const claude = read('claude/runClaude.ts');
const remote = read('claude/claudeRemote.ts');
const launcher = read('claude/claudeRemoteLauncher.ts');
const codex = read('codex/runCodex.ts');
const between = (source: string, start: string, end: string) => {
    const at = source.indexOf(start);
    expect(at).toBeGreaterThan(-1);
    return source.slice(at, source.indexOf(end, at));
};

describe('capabilities', () => {
    it('names are stable and advertised', () => {
        expect(RUN_INTENT_CAPABILITY).toBe('session-run-intent-v1');
        expect(CLAUDE_CONFIG_MODEL_CAPABILITY).toBe('claude-config-model-v1');
        expect(RUN_INTENT_RPC).toBe('session-run-intent');
        expect(claude).toContain('PROJECT_SESSION_CAPABILITY, RUN_INTENT_CAPABILITY, CLAUDE_CONFIG_MODEL_CAPABILITY],');
        expect(codex).toContain('CODEX_COMPACT_CAPABILITY, RUN_INTENT_CAPABILITY],');
    });
});

describe('Claude wrapper (runClaude.ts)', () => {
    it('records the intent each message carries, with the sticky model', () => {
        const after = between(claude, 'currentEffort = resolved.next.effort;', 'scoreFirstMessage(');
        expect(after).toContain('recordRunIntents(session, message.meta, { stickyModel: currentModel ?? null });');
    });
    it('the RPC moves the sticky model and effort, never the permission mode', () => {
        const rpc = between(claude, 'registerRunIntentRpc(session.rpcHandlerManager, session, (request) => {', 'return { stickyModel');
        expect(rpc).toContain('staleModeSnapshot: true');
        expect(rpc).toContain('currentModel = resolved.next.model;');
        expect(rpc).toContain('currentEffort = resolved.next.effort;');
    });
    it('a resume restores the recorded model and effort over the start defaults', () => {
        expect(claude).toContain('const restoredRun = reconnectSeeded ? { model: restoredModel(response.metadata), effort: restoredEffort(response.metadata) } : null;');
        expect(claude).toContain('let currentModel: string | undefined = restoredRun?.model !== undefined ? (restoredRun.model ?? undefined) : options.model ?? DEFAULT_CLAUDE_MODEL;');
        expect(claude).toContain('restoredClaudeEffort(restoredRun?.effort) ?? DEFAULT_CLAUDE_EFFORT;');
    });
    it('abort keeps the model and effort', () => {
        const reset = between(claude, 'const resetCurrentModeDefaults = () => {', '\n    };');
        expect(reset).toContain('currentFallbackModel = undefined;');
        expect(reset).not.toMatch(/currentModel\s*=/);
        expect(reset).not.toMatch(/currentEffort\s*=/);
    });
});

describe('Claude run facts (claudeRemote / launcher)', () => {
    it('asks Claude Code at every init and publishes only changes', () => {
        const init = between(remote, "if (message.type === 'system' && message.subtype === 'init') {", 'if (systemInit.session_id) {');
        expect(init).toContain('void readClaudeRunFacts(response).then((facts) => { if (facts) onRunFacts(facts); });');
        expect(launcher).toContain('if (current && applyClaudeRunFacts(current, facts) === current) return;');
    });
    it('a switch to the machine default names the settings model (live and warm adoption)', () => {
        expect(remote).toContain('const target = await liveModelTarget(response, modelTarget(next.mode.model));');
        expect(remote).toContain("await withTimeout(response.setModel(target), SET_MODEL_TIMEOUT_MS, 'set_model');");
        expect(remote).toContain('w.response.setModel(await liveModelTarget(w.response, modelTarget(initial.mode.model), w.lease.adoptTimeoutMs))');
    });
    it('a relaunched Query resuming on 「本机配置」 is put on the settings model before its first prompt', () => {
        // REGRESSION (e2e 2026-10-31): an effort change relaunched the Query and
        // Claude Code resumed on the transcript's last model (Haiku), not settings (Sonnet).
        expect(remote).toContain('const resumeOnConfigModel = !!startFrom && modelTarget(initial.mode.model) === undefined;');
        expect(remote).toContain('if (!resumeOnConfigModel) messages.push(initialUserMessage);');
        const after = between(remote, 'if (resumeOnConfigModel) {', 'timingMarks.handshakeAt = Date.now();');
        expect(after).toContain('const target = await liveModelTarget(response, undefined);');
        expect(after.indexOf('response.setModel(target)')).toBeLessThan(after.indexOf('messages.push(initialUserMessage);'));
    });
});

describe('Codex wrapper (runCodex.ts)', () => {
    it('a resume restores the effort (QA23b P2-1)', () => {
        expect(codex).toContain('const resumedEffort = reconnectSeeded && response ? restoredEffort(response.metadata, { useReportedLevel: true }) : undefined;');
        expect(codex).toContain('let currentEffort: ReasoningEffort | undefined = resumedEffort !== undefined ? (resumedEffort ?? undefined) as ReasoningEffort | undefined : DEFAULT_CODEX_EFFORT;');
    });
    it('records the intent each message carries', () => {
        const at = codex.indexOf('recordRunIntents(session, message.meta);');
        expect(at).toBeGreaterThan(codex.indexOf("logger.debug('[Codex] User message received without an effort override');"));
    });
    it('the RPC moves model / effort; 「本机配置」 resets the next meta-less turn', () => {
        const rpc = between(codex, 'registerRunIntentRpc(session.rpcHandlerManager, {', '\n    });');
        expect(rpc).toContain('pendingModelReset = !currentModel;');
        expect(rpc).toContain('currentEffort = (request.effort || undefined) as ReasoningEffort | undefined;');
        expect(codex).toContain('messageModelReset = pendingModelReset && !messageModel;');
    });
});
