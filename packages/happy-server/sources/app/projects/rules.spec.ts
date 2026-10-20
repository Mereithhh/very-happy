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
