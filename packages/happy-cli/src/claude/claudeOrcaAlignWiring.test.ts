/**
 * B-631 wiring (spec specs/2026-10-claude-wrapper-orca-align.md). The behaviour
 * lives in pure modules with their own executable tests (claudeTurnEnd,
 * claudeCommandLifecycle, claudeProcessExit, claudeSystemNotices, withTimeout);
 * what can regress silently is WHERE they are called from. Source assertions,
 * each verified with scripts/dev/mutation-check.mjs; comments are stripped first
 * so an assertion can never be satisfied by the sentence explaining it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/\n(?:[ \t]*\n)+/g, '\n');

const between = (source: string, from: string, to: string): string => {
    const start = source.indexOf(from);
    expect(start, `anchor not found: ${from}`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf(to, start);
    expect(end, `anchor not found after ${from}: ${to}`).toBeGreaterThan(start);
    return source.slice(start, end);
};

describe('Claude wrapper ↔ Orca alignment wiring (B-631)', () => {
    const launcher = read('./claudeRemoteLauncher.ts');
    const remote = read('./claudeRemote.ts');
    const runClaude = read('./runClaude.ts');
    const permissionHandler = read('./utils/permissionHandler.ts');

    it('a dead Claude Code process is reported with its exit reason exactly once: on the turn-end, or as a line when no turn was open', () => {
        const scope = between(launcher, 'if (isClaudeEdeOnlySdkError(e)) {', '} finally {');
        expect(scope).toContain('const exit = describeClaudeProcessExit(e);');
        expect(scope).toContain("const closed = session.client.closeClaudeSessionTurn('failed', { error: exit });");
        expect(scope).toContain("if (!closed) session.client.sendSessionEvent({ type: 'message', message: exit, kind: 'claude-process-exit' });");
        expect(scope).toContain('session.onSessionError(exit);');
    });

    it('api_retry frames reach the web through the gate, warnings directly, and a result starts a new retry run', () => {
        const scope = between(launcher, 'function onMessage(message: SDKMessage) {', 'if (isRuntimeCheckpointReplay(message)) return;');
        expect(scope).toContain("if (message.type === 'system' && message.subtype === 'api_retry') {");
        expect(scope).toContain('if (apiRetryGate.observe(message, Date.now())) {');
        expect(scope).toContain("session.client.sendSessionEvent({ type: 'message', message: notice, kind: 'claude-api-retry' });");
        expect(scope).toContain('const warning = describeClaudeInformational(message);');
        expect(scope).toContain("session.client.sendSessionEvent({ type: 'message', message: warning, kind: 'claude-warning' });");
        expect(scope).toContain("} else if (message.type === 'result') {\n            apiRetryGate.reset();");
    });

    it('a steer carries the web localKey end to end, and a swept user message gets the B-332 tombstone', () => {
        const trySteer = between(runClaude, 'currentSession?.trySteer({', '}) === true;');
        expect(trySteer).toContain('localKey: message.localKey,');
        const steer = between(launcher, 'session.setSteerHandler(async (input) => {', 'return true;');
        expect(steer).toContain('q.steer(message, input.mode, input.localKey);');
        const dropped = between(launcher, 'onCommandsDropped: (uuids) => {', '},');
        expect(dropped).toContain("session.client.sendQueueCancelReason(uuids, 'aborted');");
    });

    it('claudeRemote feature-detects the CLI from system/init and runs the turn lifecycle once per turn', () => {
        const init = between(remote, "if (message.type === 'system' && message.subtype === 'init') {", 'if (opts.onSDKMetadata) {');
        expect(init).toContain('cliCapabilities = new Set(Array.isArray(systemInit.capabilities) ? systemInit.capabilities : []);');
        // Only a turn the CLI announced may be ended by an idle (review 2).
        expect(init).toContain('turn.announced();');
        const result = between(remote, "if (message.type === 'result') {", "if (message.type === 'user') {");
        expect(result).toContain('const endsTurn = turn.onResult();');
        expect(result).toContain('if (endsTurn) opts.onReady(message);');
        expect(result).toContain('if (recycleIfPoisoned(message)) continue;');
        expect(result).toContain('if (endsTurn) pullNextMessage();');
        const sessionState = between(remote, 'const sessionState = readClaudeSessionState(message);', "if (message.type === 'system' && message.subtype === 'init') {");
        expect(sessionState).toContain("if (verdict === 'end') {\n                    endTurnWithoutResult();");
        // The idle end goes through the same poisoned-Query check as a result (review 5).
        const idleEnd = between(remote, 'const endTurnWithoutResult = () => {', 'updateThinking(true);\n    try {');
        expect(idleEnd).toContain('if (!recycleIfPoisoned()) pullNextMessage();');
    });

    it('the live control requests have deadlines', () => {
        expect(remote).toContain('const SET_MODEL_TIMEOUT_MS = 30_000;');
        expect(remote).toContain("await withTimeout(response.setModel(target), SET_MODEL_TIMEOUT_MS, 'set_model');");
        expect(permissionHandler).toContain('export const LIVE_PERMISSION_MODE_TIMEOUT_MS = 15_000;');
        const live = between(permissionHandler, 'await new Promise<void>((resolve) => setImmediate(resolve));', '} catch (error) {');
        expect(live).toContain("await withTimeout(this.setPermissionModeCallback(mode), LIVE_PERMISSION_MODE_TIMEOUT_MS, 'set_permission_mode');");
        const deferred = between(permissionHandler, 'if (!this.setPermissionModeCallback || this.permissionMode !== mode) return;', '});');
        expect(deferred).toContain("await withTimeout(this.setPermissionModeCallback(mode), LIVE_PERMISSION_MODE_TIMEOUT_MS, 'set_permission_mode');");
    });
});

describe('Claude wrapper ↔ Orca follow-ups wiring (B-634)', () => {
    it('① query(): the SDK-reported pid is snapshotted for reaping BEFORE the abort reaches the SDK', () => {
        const query = read('./sdk/query.ts');
        expect(query).toContain('.onProcessSpawned = (pid) => {\n        claudePid = pid');
        expect(between(query, "opts.abort.addEventListener('abort', () => {", '}, { once: true })'))
            .toMatch(/if \(claudePid !== undefined\) scheduleClaudeTreeReap\(claudePid\)\s+controller\.abort\(/);
    });

    it('① the wrapper reaps its own tree on the way out, on both exits', () => {
        const run = read('./runClaude.ts');
        const cleanup = between(run, 'const cleanup = async', "process.on('SIGTERM'");
        expect(cleanup).toContain('const wrapperTree = snapshotTree(process.pid);');
        expect(cleanup).toMatch(/await terminateSurvivors\(wrapperTree\);\s+process\.exit\(0\);/);
        expect(cleanup).toMatch(/await terminateSurvivors\(wrapperTree\)\.catch\(\(\) => undefined\);\s+process\.exit\(1\);/);
    });

    it('① the daemon stops a session wrapper together with its tree (restart and stop)', () => {
        const daemon = read('../daemon/run.ts');
        expect(between(daemon, 'const stopSessionAndWait = async', 'const restartSession = async')).toContain('const requested = terminateProcessTree(pid, () => {');
        expect(between(daemon, 'const stopSession = (sessionId: string): boolean => {', "logger.debug(`[DAEMON RUN] Session ${sessionId} not found`)")).toContain('const requested = terminateProcessTree(pid, (stopped) => {');
    });

    it('② the launcher re-sends once or tombstones what a Query ended without starting', () => {
        const launcher = read('./claudeRemoteLauncher.ts');
        const handler = between(launcher, 'onCommandsUnconfirmed: (commands, { aborted }) => {', 'onCommandsDropped:');
        expect(handler).toContain('aborted: aborted || exitReason !== null,');
        expect(handler).toContain('parkFree: !modeGate.hasParked,');
        expect(handler).toContain('modeGate.park({ message: plan.redeliver.payload.message, mode: plan.redeliver.payload.mode, uuid: plan.redeliver.uuid, finalized: true });');
        expect(handler).toContain("session.client.sendQueueCancelReason(plan.tombstone, 'aborted');");
        const remote = read('./claudeRemote.ts');
        expect(between(remote, '    } finally {\n        updateThinking(false);', '\n}\n')).toMatch(/if \(cliCapabilities\.has\(MSG_LIFECYCLE_CAPABILITY\)\) \{\s+const unconfirmed = commandTracker\.takeUnconfirmed\(\);/);
    });

    it('③ the session-scoped retired models reach every Query', () => {
        expect(read('./claudeRemoteLauncher.ts')).toContain('retiredModels: session.retiredModels,');
        const remote = read('./claudeRemote.ts');
        expect(remote).toContain('initial = withoutRetiredModel(await opts.nextMessage());');
        expect(remote).toContain('let next = withoutRetiredModel(pulled);');
    });
});
