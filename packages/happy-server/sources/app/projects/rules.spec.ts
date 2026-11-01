import { describe, expect, it } from 'vitest';
import { normalizeFolders, normalizeDefaults, noteQuotaRefusal, parseLogRef, snapshotTeamDefaults, teamMachineAllowed, readFolders } from './rules';

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
    it('noteQuotaRefusal: 5 notes/hour, 2 of them decisions, each refusal names an alternative', () => {
        const n = (kind: string, count: number) => Array.from({ length: count }, () => ({ kind }));
        expect(noteQuotaRefusal(n('finding', 4), 'finding')).toBeNull();
        expect(noteQuotaRefusal(n('finding', 5), 'finding')).toMatchObject({ limit: 5, count: 5 });
        expect(noteQuotaRefusal(n('decision', 2), 'finding')).toBeNull();
        expect(noteQuotaRefusal(n('decision', 2), 'decision')).toMatchObject({ limit: 2, count: 2 });
        expect(noteQuotaRefusal(n('decision', 2), 'decision')!.suggestion).toContain('supersede');
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
        { agent: 'claude', machineId: 'm2', id: 'dup-agent' },
        { agent: 'codex', machineId: 'm1', id: null },
    ];

    it('normalizeDefaults validates agentProfiles and keeps one per agent', () => {
        expect(normalizeDefaults({ agentProfiles: entries } as any).agentProfiles).toEqual([entries[0], entries[2]]);
        expect(normalizeDefaults({ agentProfiles: null } as any).agentProfiles).toBeNull();
        expect('agentProfiles' in normalizeDefaults({ agentProfiles: [{ agent: 'claude', id: 'no-machine' }] } as any)).toBe(false);
    });

    it('snapshotTeamDefaults copies the account for the team\'s agent on the team\'s machine, never over the team\'s own', () => {
        expect(snapshotTeamDefaults({ assistant: 'claude' }, { agentProfiles: entries }, 'm1')).toEqual({ assistant: 'claude', agentProfile: { id: 'org-a', label: 'Org A' } });
        expect(snapshotTeamDefaults({ assistant: 'codex' }, { agentProfiles: entries }, 'm1')).toEqual({ assistant: 'codex', agentProfile: null });
        expect(snapshotTeamDefaults({ assistant: 'claude' }, { agentProfiles: entries }, 'm3')).toBeNull();
        expect(snapshotTeamDefaults({ assistant: 'claude', agentProfile: { id: 'mine' } }, { agentProfiles: entries }, 'm1')).toBeNull();
        expect(snapshotTeamDefaults({ assistant: 'claude' }, { agentProfiles: entries })).toBeNull();
    });
});
