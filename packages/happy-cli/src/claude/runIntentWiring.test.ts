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
const daemon = read('daemon/run.ts');
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
        expect(after).toContain('recordRunIntents(session, resolved.ignoredEffort !== undefined ? withoutEffort(message.meta) : message.meta, { stickyModel: currentModel ?? null });');
    });
    // REGRESSION (QA28 P2-4): an effort Claude ignores is not recorded as the intent.
    it('the RPC reports an ignored effort as refused', () => {
        const rpc = between(claude, 'registerRunIntentRpc(session.rpcHandlerManager, session, (request) => {', '\n    });');
        expect(rpc).toContain("return { facts: { stickyModel: currentModel ?? null }, effortRefused: resolved.ignoredEffort !== undefined };");
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
        const at = codex.indexOf('recordRunIntents(session, effortRefused ? withoutEffort(message.meta) : message.meta);');
        expect(at).toBeGreaterThan(codex.indexOf("logger.debug('[Codex] User message received without an effort override');"));
    });
    it('the RPC moves model / effort; 「本机配置」 resets the next meta-less turn', () => {
        const rpc = between(codex, 'registerRunIntentRpc(session.rpcHandlerManager, {', '\n    });');
        expect(rpc).toContain('pendingModelReset = !currentModel;');
        expect(rpc).toContain('effortRefused = unsupportedEffortReason(discoveredModels, effortJudgeModel(currentModel, pendingModelReset), effort) !== null;');
        expect(rpc).toContain('if (!effortRefused) currentEffort = effort;');
        expect(rpc).toContain('return { effortRefused };');
        expect(codex).toContain('messageModelReset = pendingModelReset && !messageModel;');
    });
    // REGRESSION (QA28 P2-4): astra + minimal was refused yet became the sticky
    // level and the session's intent — every device's label went blank and every
    // later message without meta failed the same way.
    it('a refused explicit effort is neither sticky nor recorded', () => {
        const receipt = between(codex, "} else if (typeof incoming === 'string') {", "logger.debug('[Codex] Valid effort override applied');");
        expect(receipt).toContain('effortRefused = unsupportedEffortReason(discoveredModels, effortJudgeModel(messageModel, messageModelReset), messageEffort) !== null;');
        expect(receipt).toMatch(/if \(effortRefused\) \{[^}]*\} else \{\s*currentEffort = messageEffort;/);
        expect(codex).toContain('...(effortExplicit ? { effortExplicit: true } : {}),');
    });
    it('a refused held level rolls back (sticky + intent); only an explicit one fails the turn', () => {
        const loop = between(codex, 'const turnEffort = settleTurnEffort(', 'const includeAppendSystemPrompt');
        expect(loop).toContain('explicit: message.mode.effortExplicit === true,');
        expect(loop).toContain('fallback: lastStartedEffort,');
        expect(loop).toMatch(/if \(currentEffort === refused\) \{\s*currentEffort = turnEffort\.effort;/);
        expect(loop).toContain('if (readEffortIntent(session.getMetadata()?.effortIntent) === refused) {');
        expect(loop).toContain('recordRunIntents(session, { effort: turnEffort.effort ?? null, effortIntent: turnEffort.effort ?? EFFORT_INTENT_AUTO });');
        expect(loop).toContain('throw new Error(turnEffort.refusal);');
        expect(codex).toContain('effort: turnEffort.effort,');
        expect(codex).toMatch(/onTurnStarted: \(\) => \{\s*lastStartedEffort = turnEffort\.effort;/);
    });
});

describe('auto-restart (B-852) relaunches into the restore path (QA27 P2-1)', () => {
    // REGRESSION (QA27 P2-1): an idle auto-restart dropped effort and the 1M model
    // for messages without meta. The daemon relaunches as a reconnect with no
    // --model, so the new wrapper's restoredRun / resumedEffort (above) apply.
    it('the auto restart is a seeded reconnect that passes no model of its own', () => {
        expect(daemon).toContain("const result = await restartSession(sessionId, { keepPublishedPermissionMode: true, auto: { kind: staleness.kind, target: staleness.target } });");
        const impl = between(daemon, 'const restartSessionImpl = async', 'const stopSession = ');
        expect(impl).toContain('const model = sanitizeResumeModel(options?.model);');
        expect(impl).toContain('HAPPY_RECONNECT_SESSION_ID: happySessionId,');
    });
});

describe('spawn / team / automation first messages carry the choice (QA28 P2-5)', () => {
    // REGRESSION (QA28 P2-5): `spawn` without --model recorded the resolved
    // `claude-opus-5-5` as the intent, so the session stopped following latest.
    const sender = read('commands/sessionMessage.ts');
    const worker = read('daemon/teams/worker.ts');
    const runner = read('daemon/automations/runner.ts');
    it('the CLI sender forwards the intent keys', () => {
        expect(sender).toContain('...(options.modelIntent !== undefined ? { modelIntent: options.modelIntent } : {}),');
        expect(sender).toContain('...(options.effortIntent !== undefined ? { effortIntent: options.effortIntent } : {}),');
    });
    it('a team member and an automation send the resolved meta with its intent', () => {
        expect(worker).toContain("sentFrom: 'team', ...teamInitialModelMeta(op.model) });");
        expect(runner).toContain("const meta = resolveFirstMessageMeta({ agent, permissionMode, explicitModel: action.model ?? undefined, capabilities });");
        expect(runner).toContain("await send(spawned.sessionId, `${header}\\n${action.prompt}`, { localId: `automation-${run.id}`, ...meta });");
    });
});
