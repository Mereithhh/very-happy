/**
 * B-902 wiring (source assertions, verified with scripts/dev/mutation-check.mjs)
 * plus the pure 「项目在别的电脑上设了账号」 rule: project accounts are edited
 * per agent × machine and only the changed cells are written onto the latest
 * saved entries; the composer and the new-session pickers say where the
 * account comes from and link to the project's 账号 settings.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectAccountElsewhere } from '@/sync/accountChoice';

const src = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8');

describe('B-902 project accounts per machine', () => {
    it('「项目在别的电脑上设了」 only when this machine has no entry for the agent', () => {
        const project = [
            { agent: 'claude', machineId: 'm1', id: 'corp' },
            { agent: 'claude', machineId: 'm2', id: 'corp-2' },
            { agent: 'codex', machineId: 'm1', id: null },
        ];
        expect(projectAccountElsewhere('claude', 'm1', project)).toBeNull();
        expect(projectAccountElsewhere('claude', 'm2', project)).toBeNull();
        expect(projectAccountElsewhere('claude', 'm3', project)).toEqual(['m1', 'm2']);
        expect(projectAccountElsewhere('codex', 'm2', project)).toEqual(['m1']);
        expect(projectAccountElsewhere('claude', 'm1', null)).toBeNull();
    });

    it('settings: one cell per agent × machine, saved as edits onto the re-read project', () => {
        const section = src('screens/projects/ProjectAccountsSection.tsx');
        expect(section).toContain('const machineIds = projectAccountMachineIds(project.folders, saved);');
        expect(section).toContain('const latest = (await projectsApi.get(project.id)).project;');
        expect(section).toContain('const next = applyProjectAccountEdits(latest.defaults.agentProfiles, edits);');
        expect(section).toContain('await projectsApi.update(project.id, { defaults: { ...latest.defaults, agentProfiles: next } });');
        expect(section).toContain('const canAdd = editable && online && !!onAdd && machineHasAgentAccounts(state, agent) && accountsForAgent(state, agent).length === 0;');
        expect(src('screens/projects/ProjectSettingsScreen.tsx')).toContain('<ProjectAccountsSection key={`accounts:${project.updatedAt}`}');
    });

    it('the project composer shows the account and its source; pickers link to the project settings', () => {
        const screen = src('screens/projects/ProjectScreen.tsx');
        expect(screen).toContain('{account && <ComposerAccount projectId={detail.project.id} account={account} />}');
        expect(screen).toContain('spawnDefaultOptionLabel(state, agent, machine.id, entries, t)');
        // Q3 before creating: an unusable project account stops the composer, with the reason and both fixes.
        expect(screen).toContain('if (!folder || !first || busy || blocked) return;');
        expect(screen).toContain("{account.blockText} <Link to={accountSettingsHref(machine.id)}>{t('accounts.blockedFix')}</Link>");
        expect(src('screens/sessions/NewSessionModal.tsx')).toContain("onSetProjectAccount: () => { onClose(); navigate(projectSettingsPath(projectId, 'accounts')); }");
        expect(src('screens/issues/AssigneeFields.tsx')).toContain("onSetProjectAccount: () => navigate(projectSettingsPath(projectId, 'accounts'))");
    });

    it('a daemon account refusal reads as a sentence even when the RPC threw / resolved { error }', () => {
        const runtime = src('sync/pendingSessionsRuntime.ts');
        expect(runtime).toContain("if (parseSpawnAccountError(error instanceof Error ? error.message : String(error))) return { type: 'error', errorMessage: t('accounts.spawnUnavailable') };");
        expect(runtime).toContain("if (result.type === 'error' && parseSpawnAccountError(result.errorMessage)) result = { type: 'error', errorMessage: t('accounts.spawnUnavailable') };");
    });

    it('a project account no longer on its machine says so under the picker', () => {
        expect(src('screens/projects/ProjectAccountsSection.tsx')).toContain("const missing = shown.kind === 'account' && shown.missing;");
    });
});
