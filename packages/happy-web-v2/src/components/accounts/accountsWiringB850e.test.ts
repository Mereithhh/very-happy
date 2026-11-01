/**
 * B-850e wiring across files (source assertions, verified with
 * scripts/dev/mutation-check.mjs): project defaults reach the spawn, a member
 * account change switches a live member in place, team defaults keep the
 * account on save, a fork inherits (no account sent), and the board re-words
 * team refusals with their actions.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8');

describe('B-850e accounts wiring', () => {
    it('a draft without a pick spawns on the project default (explicit > project > machine)', () => {
        const runtime = src('sync/pendingSessionsRuntime.ts');
        expect(runtime).toContain('if (options.agentProfileId === undefined && launch?.projectId) {');
        expect(runtime).toContain("options = { ...options, ...spawnAgentProfileParam(readMachineAgentProfiles(machine), options.agent ?? 'claude', undefined, { project, machineId: options.machineId }) };");
        expect(src('sync/pendingSessions.ts')).toContain('}, record.onSpawnedProject ? { projectId: record.onSpawnedProject.projectId } : undefined);');
    });

    it('the draft card and its Q3 block see the project default', () => {
        expect(src('screens/session/PendingSessionParts.tsx')).toContain('project={projectAccountsOf(record.onSpawnedProject?.projectId, projectsSnap.projects)}');
        expect(src('screens/session/SessionDetailScreen.tsx')).toContain('{ project: projectAccountsOf(pending.onSpawnedProject?.projectId, pendingProjects.projects), machineId: pending.machineId }');
        expect(src('components/accounts/SpawnAccountPicker.tsx')).toContain('resolveSpawnAccount(state, agent, value, now, launch)');
    });

    it('member account: set-bot-account, then agent-profile-bind when the member is online', () => {
        const members = src('screens/teams/TeamMemberAccounts.tsx');
        expect(members).toContain("const ok = await act({ type: 'set-bot-account', botId: bot.id, ...(choice !== undefined ? { agentProfile: choice } : {}) });");
        expect(members).toContain('const result = await agentProfileBind(team.machineId, { sessionId: session.id, accountId: target });');
        expect(src('screens/teams/TeamsScreen.tsx')).toContain('<TeamMemberAccounts team={team} disabled={disabled} act={actApplied} />');
    });

    it('team defaults: the account is sent back on save (set-defaults replaces the object) and an agent change clears it', () => {
        const options = src('screens/teams/TeamOptions.tsx');
        expect(options).toContain('...(account !== undefined ? { agentProfile: account } : {})');
        expect(options).toContain('const setAssistant = (next: TeamAssistant) => { if (next !== assistant) setAccount(undefined); setAssistantState(next); };');
        const start = src('screens/teams/TeamStartForm.tsx');
        expect(start).toContain("...(account !== undefined ? { agentProfile: account } : {}) };");
        expect(start).toContain("const setAssistant = (next: TeamLaunchInput['assistant']) => { if (next !== assistant) setAccount(undefined); setAssistantState(next); };");
    });

    it('delegate: the hidden choice becomes the action field', () => {
        const screen = src('screens/teams/TeamsScreen.tsx');
        expect(screen).toContain('const choice = decodeAccountChoice(String(f.get("agentProfile") ?? "")); return choice !== undefined ? { agentProfile: choice } : {};');
        expect(screen).toContain('<input type="hidden" name="agentProfile" value={encodeAccountChoice(account)} />');
    });

    it('fork (rewind) sends no account: the daemon inherits the parent\'s', () => {
        const rewind = src('screens/session/rewindOperation.ts');
        expect(rewind).toContain('parentSessionId: source.sessionId');
        expect(rewind).not.toContain('agentProfileId');
    });

    it('board: team-account items read in the reader\'s language and offer the ways out', () => {
        const card = src('screens/session/board/BoardCard.tsx');
        expect(card).toContain('const accountText = teamAccountItemText(item);');
        expect(card).toContain('<TeamAccountItemActions item={item} />');
        expect(src('screens/session/board/TeamAccountItem.tsx')).toContain("await actOnTeam(teamId, { type: 'retry-operation', operationId: op.id, claimId: op.claimId }, crypto.randomUUID());");
    });

    it('automation attention: account refusals get relogin / change-account entries', () => {
        const attn = src('screens/automations/AttentionSection.tsx');
        expect(attn).toContain("navigate(accountSettingsHref(run.machineId, accountId))");
        // 修好后「再跑一次」 closes the refusal row
        expect(attn).toContain("if (isAccountRefusal(run)) await ack(run.id, 'owner');");
        expect(src('screens/automations/AutomationShared.tsx')).toContain('const account = accountRefusalText({ ...run, error: run.error ?? null });');
    });
});
