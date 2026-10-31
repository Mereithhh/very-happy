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
        expect(run).toContain('const decision = options?.auto ? { allowed: true as const } : decideRestart(prior, DEFAULT_MAX_RESTARTS);');
        expect(run).toContain('if (!options?.auto) restartCounts.set(happySessionId, recordRestartAttempt(prior));');
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
        expect(claude).toContain('HIBERNATION_CAPABILITY, AUTO_RESTART_CAPABILITY, PROJECT_SESSION_CAPABILITY, RUN_INTENT_CAPABILITY, CLAUDE_CONFIG_MODEL_CAPABILITY]');
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
