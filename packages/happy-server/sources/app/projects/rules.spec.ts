import { describe, expect, it } from 'vitest';
import { PROJECT_ERROR_CODES, PROJECT_LIMITS, ProjectLogCreateSchema } from '@slopus/happy-wire';
import { normalizeFolders, normalizeDefaults, parseLogRef, snapshotTeamDefaults, teamMachineAllowed, readFolders } from './rules';

describe('project rules', () => {
    it('normalizeFolders keeps one primary (first flagged, else first) and dedupes trailing-slash variants', () => {
        expect(normalizeFolders([])).toEqual([]);
        expect(normalizeFolders([{ machineId: 'm', path: '/a/' }, { machineId: 'm', path: '/a' }, { machineId: 'n', path: '/' }]))
            .toEqual([{ machineId: 'm', path: '/a', primary: true }, { machineId: 'n', path: '/', primary: false }]);
        expect(normalizeFolders([{ machineId: 'm', path: '/a' }, { machineId: 'm', path: '/b', primary: true }, { machineId: 'm', path: '/c', primary: true }]).map(f => f.primary))
            .toEqual([false, true, false]);
    });
    it('normalizeDefaults/readFolders keep only known shapes', () => {
        expect(normalizeDefaults({ agent: 'pi', permissionMode: 'future-mode', extra: 1 } as any)).toEqual({ agent: 'pi', permissionMode: 'future-mode' });
        expect(readFolders([{ machineId: 'm', path: '/x' }, { nope: true }, 'x'])).toEqual([{ machineId: 'm', path: '/x', primary: false }]);
        expect(readFolders(null)).toEqual([]);
    });
    it('B-964: log entries have no per-hour count, only length/byte bounds', () => {
        expect(PROJECT_LIMITS).not.toHaveProperty('notesPerHour');
        expect(PROJECT_LIMITS).not.toHaveProperty('decisionsPerHour');
        expect(PROJECT_ERROR_CODES).not.toContain('project_note_quota_exceeded' as any);
        const ok = { kind: 'decision', title: 't', body: 'x'.repeat(PROJECT_LIMITS.logBodyBytes) };
        expect(ProjectLogCreateSchema.safeParse(ok).success).toBe(true);
        // Byte bound, not char bound: 2048 × 3-byte chars = 6KB > 4KB.
        expect(ProjectLogCreateSchema.safeParse({ ...ok, body: '中'.repeat(PROJECT_LIMITS.logBodyBytes / 2) }).success).toBe(false);
        expect(ProjectLogCreateSchema.safeParse({ ...ok, body: 'x'.repeat(PROJECT_LIMITS.logBodyBytes + 1) }).success).toBe(false);
        expect(ProjectLogCreateSchema.safeParse({ ...ok, title: 'x'.repeat(PROJECT_LIMITS.logTitleChars + 1) }).success).toBe(false);
    });
    it('parseLogRef accepts #12 / 12 as seq, anything else as id', () => {
        expect(parseLogRef('#12')).toEqual({ seq: 12 });
        expect(parseLogRef(' 7 ')).toEqual({ seq: 7 });
        expect(parseLogRef('abc-123')).toEqual({ id: 'abc-123' });
    });
    it('teamMachineAllowed requires the team machine among folder machines', () => {
        expect(teamMachineAllowed([], 'm')).toBe(false);
        expect(teamMachineAllowed([{ machineId: 'm', path: '/' }], 'm')).toBe(true);
    });
    it('snapshotTeamDefaults fills only unset fields and ignores agents a team cannot run', () => {
        expect(snapshotTeamDefaults({ assistant: 'claude' }, { agent: 'codex', model: 'm1' })).toEqual({ assistant: 'claude', model: 'm1' });
        expect(snapshotTeamDefaults({ assistant: 'claude', model: 'own' }, { agent: 'codex', model: 'm1' })).toBeNull();
        expect(snapshotTeamDefaults(undefined, { agent: 'gemini' })).toBeNull();
        expect(snapshotTeamDefaults(undefined, { agent: 'pi-acp' })).toEqual({ assistant: 'pi-acp' });
    });
});

describe('project error statuses', () => {
    it('never answers 401/403 for a project-domain refusal (Web treats those as signed out)', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const source = readFileSync(join(process.cwd(), 'sources/app/projects/store.ts'), 'utf8');
        expect(source).not.toMatch(/requireProject\([^;]*, 40[13]\)/);
        expect(source).not.toMatch(/new ProjectError\([^)]*, 40[13]/);
    });
});

describe('B-850d project accounts', () => {
    const entries = [
        { agent: 'claude', machineId: 'm1', id: 'org-a', label: 'Org A' },
        { agent: 'claude', machineId: 'm2', id: 'org-a-m2' },
        { agent: 'codex', machineId: 'm1', id: null },
    ];

    it('normalizeDefaults validates agentProfiles and keeps one per agent per machine (B-902)', () => {
        expect(normalizeDefaults({ agentProfiles: entries } as any).agentProfiles).toEqual(entries);
        const dup = [...entries, { agent: 'claude', machineId: 'm1', id: 'dup-same-machine' }];
        expect(normalizeDefaults({ agentProfiles: dup } as any).agentProfiles).toEqual(entries);
        expect(normalizeDefaults({ agentProfiles: null } as any).agentProfiles).toBeNull();
        expect('agentProfiles' in normalizeDefaults({ agentProfiles: [{ agent: 'claude', id: 'no-machine' }] } as any)).toBe(false);
    });

    it('snapshotTeamDefaults copies the account for the team\'s agent on the team\'s machine, never over the team\'s own', () => {
        expect(snapshotTeamDefaults({ assistant: 'claude' }, { agentProfiles: entries }, 'm1')).toEqual({ assistant: 'claude', agentProfile: { id: 'org-a', label: 'Org A' } });
        expect(snapshotTeamDefaults({ assistant: 'codex' }, { agentProfiles: entries }, 'm1')).toEqual({ assistant: 'codex', agentProfile: null });
        expect(snapshotTeamDefaults({ assistant: 'claude' }, { agentProfiles: entries }, 'm3')).toBeNull();
        expect(snapshotTeamDefaults({ assistant: 'claude' }, { agentProfiles: entries }, 'm2')).toEqual({ assistant: 'claude', agentProfile: { id: 'org-a-m2' } });
        expect(snapshotTeamDefaults({ assistant: 'claude', agentProfile: { id: 'mine' } }, { agentProfiles: entries }, 'm1')).toBeNull();
        expect(snapshotTeamDefaults({ assistant: 'claude' }, { agentProfiles: entries })).toBeNull();
    });
});
