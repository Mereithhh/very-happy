import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// B-852: the daemon wiring of automatic restarts. Verified with scripts/dev/mutation-check.mjs (see PR).
const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const run = read('daemon', 'run.ts');
const claude = read('claude', 'runClaude.ts');
const codex = read('codex', 'runCodex.ts');
const acp = read('agent', 'acp', 'runAcp.ts');

describe('B-852 auto-restart wiring', () => {
    it('the idle check-in decides it; hibernation (exit) wins when both say yes', () => {
        expect(run).toContain('if (reply.hibernate) return reply;\n        const auto = await autoRestartScheduler.onCheckIn(body);');
        expect(run).toContain('nextCheckMs: Math.min(reply.nextCheckMs ?? AUTO_RESTART_RECHECK_CAP_MS, AUTO_RESTART_RECHECK_CAP_MS, auto.nextCheckMs ?? Infinity) };');
    });
    it('the 10-minute check-in cap holds with the switch off too (QA25 P2-3)', () => {
        expect(run).toContain('const auto = await autoRestartScheduler.onCheckIn(body);\n        // Never let a wrapper sleep past the cap');
        expect(run).not.toContain('if (!autoRestartSetting) return reply;');
    });
    it('a recovered wrapper\'s spawn origin comes from its own event echo (B-882)', () => {
        expect(run).toContain('if (spawnedByFromSession) echoedSpawnedBy.set(sessionId, spawnedByFromSession);');
        expect(run).toContain('spawnedBy: tracked.spawnedBy ?? (tracked.happySessionId ? echoedSpawnedBy.get(tracked.happySessionId) : undefined) ?? null,');
    });
    it('terminal sessions are told apart by the wrapper\'s own startedBy (QA25 P2-1)', () => {
        expect(run).toContain('startedBy: metadata?.startedBy ?? null,');
    });
    it('the offline retry asks the server whether anyone restored or archived it (QA25 P2-2)', () => {
        expect(run).toContain('return { active: row.active, archived: row.archivedAt != null };');
    });
    it('the restart is the manual restart path, keeps the permission mode and tags the new wrapper', () => {
        expect(run).toContain('const result = await restartSession(sessionId, { keepPublishedPermissionMode: true, auto: { kind: staleness.kind, target: staleness.target } });');
        expect(run).toContain('...(options?.auto ? { [AUTO_RESTARTED_ENV]: encodeAutoRestarted(options.auto.kind, options.auto.target) } : {}),');
    });
    it('automatic restarts never use up the manual breaker', () => {
        expect(run).toContain('const decision = options?.auto || options?.queued ? { allowed: true as const } : decideRestart(prior, options?.account ? DEFAULT_MAX_ACCOUNT_RESTARTS : DEFAULT_MAX_RESTARTS);');
        expect(run).toContain('if (!options?.auto && !options?.queued) counts.set(happySessionId, recordRestartAttempt(prior));');
    });
    it('a team lead is not told "exited" for an automatic restart', () => {
        expect(run).toContain("if (session?.happySessionId && !autoRestartExits.has(session.happySessionId) && (session.spawnedBy === 'teams'");
    });
    it('an Automations run in flight blocks it; the conversation must be on disk', () => {
        expect(run).toContain('automationRunning: (sessionId) => automationRunner?.hasSession(sessionId) === true,');
        expect(run).toContain('conversationExists: (cwd, claudeSessionId) => locateClaudeConversation(cwd, claudeSessionId) !== null,\n        }).ok;');
        // judged on the server's metadata (the local copy can lack the conversation id)
        expect(run).toContain('() => fetchServerSessionMetadata(sessionId, encryption.encryptionKey, encryption.encryptionVariant));\n        return resumePrecheck(metadata, {');
    });
    it('the machine switch persists and is published', () => {
        expect(run).toContain('await updateSettings((current) => ({ ...current, autoRestartSessions: enabled }));');
        expect(run).toContain('let autoRestartSetting: boolean = (await readSettings()).autoRestartSessions !== false;');
        expect(run).toContain('publish: (sessions) => { void apiMachineRef?.setAutoRestartSessions(sessions); },');
    });
    it('every runner posts the "updated" line and advertises the capability', () => {
        for (const src of [claude, codex, acp]) {
            expect(src).toMatch(/const autoUpdated = takeAutoRestartedEvent\(process\.env(, 'Codex')?\);\n\s+if \(autoUpdated\) session\.sendSessionEvent\(autoUpdated\);/);
        }
        expect(claude).toContain('HIBERNATION_CAPABILITY, AUTO_RESTART_CAPABILITY, PROJECT_SESSION_CAPABILITY, RUN_INTENT_CAPABILITY, CLAUDE_CONFIG_MODEL_CAPABILITY, AGENT_PROFILE_SESSION_CAPABILITY]');
        expect(codex).toContain('HIBERNATION_CAPABILITY, AUTO_RESTART_CAPABILITY, CODEX_STEER_CAPABILITY');
        expect(acp).toContain("...(opts.agentName === 'pi' && opts.startedBy === 'daemon' ? [AUTO_RESTART_CAPABILITY] : [])],");
    });
    it('Codex reports the agent version its model catalog came from', () => {
        expect(codex).toContain('codexAgentVersion = client.serverVersion;');
        expect(codex).toContain('...(codexAgentVersion ? { agentVersion: codexAgentVersion } : {}),');
    });
    it('pi reports quiescence but never commits a hibernation', () => {
        expect(acp).toContain('commit: async () => false,');
        expect(acp).toContain('pendingRequests: Object.keys(session.getAgentState()?.requests ?? {}).length,\n          backgroundTasks: 0,');
    });
});

// B-856: verified with scripts/dev/mutation-check.mjs (see PR).
describe('B-856 wiring', () => {
    const main = read('main.ts');
    const logPrune = read('ui', 'logPrune.ts');
    it('the scheduler is told when this daemon is about to be replaced (controller state or a new bundle on disk)', () => {
        expect(run).toContain('const upgradePending = () => pendingUpgradeVersion({\n      daemonVersion: packageJson.version,\n      autoUpdate: cliUpdateStateRef?.autoUpdate,\n      bundleReplaced: bundleReplacedSeen,\n    });');
        expect(run).toContain('      upgradePending,\n      publish: (sessions)');
        expect(run).toContain('if (bundleReplaced) bundleReplacedSeen = true;');
    });
    it('daemon list reads the status and daemon facts locally; --json carries them', () => {
        expect(run).toContain('getAutoRestartStatus: (sessionId: string) => autoRestartScheduler.statuses()[sessionId],');
        expect(run).toContain('getDaemonInfo: () => ({ version: packageJson.version, upgradePending: upgradePending(), autoRestartEnabled: autoRestartSetting }),');
        expect(main).toContain("console.log(JSON.stringify({ daemon: daemon ?? null, sessions }, null, 2))");
        expect(main).toContain('for (const line of formatDaemonList(sessions, daemon)) console.log(line)');
    });
    it('previous daemon logs are exempt from the general sweep', () => {
        expect(logPrune).toContain('const doomed = planLogPrune(files.filter((f) => !daemonLogs.keep.has(f.path)), Date.now(), policy, protectedPaths)');
        expect(logPrune).toContain('if (daemonLogs.trim) trimToTail(daemonLogs.trim.path, daemonLogs.trim.keepBytes)');
    });
});

// B-911: queued idle restarts (owner card / the agent's own request). Verified with scripts/dev/mutation-check.mjs (see PR).
const machine = read('api', 'apiMachine.ts');
const control = read('daemon', 'controlServer.ts');
const happyServer = read('claude', 'utils', 'startHappyServer.ts');
const bridge = read('codex', 'happyMcpStdioBridge.ts');
describe('B-911 idle restart wiring', () => {
    it('the card button (`whenIdle`) queues instead of restarting now, and the daemon advertises it', () => {
        expect(run).toContain('restartSession: (sessionId, options) => options?.whenIdle ? idleRestartRequestFromOwner(sessionId) : restartSession(sessionId, options),');
        expect(machine).toContain('...(whenIdle === true ? { whenIdle: true as const } : {})');
        expect(machine).toContain("idleGuard: true, idleRestart: true, sessions: state.sessions };");
    });
    it('only the wrapper the daemon tracks under that pid can queue its own restart', () => {
        expect(run).toContain("if (!tracked || tracked.happySessionId !== sessionId || !isPidAlive(pid)) return { ok: false, code: 'not-caller' };\n        return idleRestart!.request({ sessionId, source: 'agent' });");
        expect(happyServer).toContain('idleRestartToolResult(await requestIdleRestartViaDaemon(client.sessionId, process.pid))');
        expect(control).toContain("typed.post('/session-restart-request'");
        expect(bridge).toContain('callTool({ name: IDLE_RESTART_TOOL_NAME, arguments: {} })');
    });
    it('B-919: the main agent\'s restart is a new control route on the owner queue / the ifIdle restart', () => {
        expect(control).toContain("typed.post('/session-restart-owner'");
        expect(run).toContain("queue: (sessionId) => idleRestart!.request({ sessionId, source: 'owner', target: autoRestartScheduler.statuses()[sessionId]?.target ?? null }),");
        expect(run).toContain("const result = await restartSession(sessionId, { keepPublishedPermissionMode: true, ifIdle: true });");
        expect(run).toContain('      requestOwnerRestart,');
        // QA P2-2: the owner's `now` sees the queue's own inputs (automation runs, the last turn edge, the quiet period).
        expect(run).toContain('automationRunning: automationRunner?.hasSession(sessionId) === true,\n        upgradePending: upgradePending(),\n        lastTurnEventAt: idleRestart!.lastTurnEventAt(sessionId),');
        expect(run).toContain('      quietMs: idleRestartTiming.quietMs,');
        expect(run).toContain('      watchingSince: idleRestartWatchingSince,\n      minObserveMs: IDLE_RESTART_MIN_OBSERVE_MS,');
    });
    it('turn edges and wrapper exits reach the queue', () => {
        expect(run).toContain('turnActivity.onEvent((sessionId, event) => idleRestart?.noteTurn(sessionId, event));');
        expect(run).toContain('if (session?.happySessionId) idleRestart?.forget(session.happySessionId);');
    });
    it('the restart keeps history, mode and the old wrapper\'s run intent; a lead is not told "exited"', () => {
        expect(run).toContain("const intent = tracked && facts?.flavor === 'claude' ? await claudeChildRunIntent(tracked.pid) : {};");
        expect(run).toContain('keepPublishedPermissionMode: true,\n            queued: true,');
        expect(run).toContain('...(options?.effort ? { [RESTART_EFFORT_ENV]: options.effort } : {}),');
        expect(run).toContain("...(entry.source === 'agent' ? { requested: true as const } : behind ? { auto: { kind: 'cli' as const, target: packageJson.version } } : {}),");
        expect(run).toContain('autoRestartExits.add(sessionId);\n        try {\n          const result = await restartSession(sessionId, {\n            keepPublishedPermissionMode: true,');
        expect(claude).toContain('restoredClaudeEffort(restoredRun?.effort) ?? (restoredRun?.effort === undefined ? restartEffort ?? undefined : undefined) ?? DEFAULT_CLAUDE_EFFORT;');
    });
    it('stuck wrappers get the card; a queued restart settles it', () => {
        expect(run).toContain('onStuck: (sessionId, status, session) => {\n        void staleWrapperNotices.stuck(');
        expect(run).toContain('if (idleRestart?.status(sessionId)) return;');
        expect(run).toContain("onQueued: (sessionId, entry) => { if (entry.source === 'owner') void staleWrapperNotices.queued(sessionId); },");
        expect(run).toContain("if (outcome.ok) void staleWrapperNotices.settle(sessionId, 'done', `已在空闲时重启到 CLI ${packageJson.version}，历史保留。`).finally(() => autoRestartScheduler.sweep());");
    });
});
