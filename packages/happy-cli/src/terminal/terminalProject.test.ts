import { describe, expect, it } from 'vitest';
import { parseTerminalProjectId, validateTerminalProjectId } from './terminalProject';
import { LIST_FIELD_SEP, parseSessionListLine, terminalListSignature, type TerminalListItem } from './webTerminal';
import { liveSnapshotChanged, sanitizeLiveSnapshot } from './liveTerminals';
import { sanitizeClosedTerminals } from './closedTerminals';
import { planTerminalRestore } from './terminalRestore';
import { selectAutoRestore } from './autoRestore';

const PID = '3f2c1a9e-8b7d-4c6e-9f00-112233445566';
const mk = (...fields: string[]) => fields.join(LIST_FIELD_SEP);

describe('B-868 terminal project id', () => {
    it('accepts a server project id (uuid) or null; rejects anything else as invalid input', () => {
        expect(validateTerminalProjectId(PID)).toBe(PID);
        expect(validateTerminalProjectId(null)).toBeNull();
        for (const bad of [undefined, '', ' ', 'a b', 'x;rm -rf', 'é', 'a'.repeat(65), 42, {}]) {
            expect(validateTerminalProjectId(bad)).toBeUndefined();
        }
    });

    it('a hand-edited or corrupt @vh_project reads as no project, never poisons the list', () => {
        expect(parseTerminalProjectId('')).toBeNull();
        expect(parseTerminalProjectId('bad id')).toBeNull();
        expect(parseTerminalProjectId(` ${PID} `)).toBe(PID);
        expect(parseTerminalProjectId(undefined)).toBeNull();
    });

    it('the list line carries @vh_project before pane_title', () => {
        const line = mk('vh-abc', '1', '2', '/x', '', '', '[]', '', '80', '24', 'zsh', PID, `a${LIST_FIELD_SEP}b`);
        const parsed = parseSessionListLine(line)!;
        expect(parsed.projectId).toBe(PID);
        expect(parsed.paneTitle).toBe(`a${LIST_FIELD_SEP}b`);
        expect(parseSessionListLine(mk('vh-abc', '1', '2', '/x', '', '', '[]', '', '80', '24', 'zsh', '', 't'))!.projectId).toBeNull();
    });

    it('moving a terminal between projects changes the list signature (so the daemon pushes)', () => {
        const base: TerminalListItem = { id: 't1', title: 'x', tags: [], projectId: null };
        const sig = terminalListSignature([base]);
        expect(terminalListSignature([{ ...base, projectId: PID }])).not.toBe(sig);
        expect(terminalListSignature([{ ...base, projectId: 'other' }])).not.toBe(terminalListSignature([{ ...base, projectId: PID }]));
    });

    it('survives the persisted live snapshot and its change check', () => {
        const map = sanitizeLiveSnapshot({ t1: { cwd: '/w', seenAt: 100, projectId: PID }, t2: { cwd: '/w', seenAt: 100, projectId: 'bad id' } }, 200);
        expect(map.get('t1')!.projectId).toBe(PID);
        expect(map.get('t2')!.projectId).toBeUndefined();
        const moved = new Map(map);
        moved.set('t1', { ...map.get('t1')!, projectId: 'other' });
        expect(liveSnapshotChanged(map, moved)).toBe(true);
    });

    it('a closed terminal keeps its project and a restore puts it back', () => {
        const [record] = sanitizeClosedTerminals([{ id: 't1', cwd: '/w', closedAt: 5, projectId: PID }]);
        expect(record.projectId).toBe(PID);
        const plan = planTerminalRestore(record, { tmuxAlive: false, cwdExists: () => true, conversationExists: () => false });
        expect(plan).toMatchObject({ kind: 'create', terminalId: 't1', projectId: PID });
        const none = planTerminalRestore({ id: 't2', cwd: '/w', closedAt: 5 }, { tmuxAlive: false, cwdExists: () => true, conversationExists: () => false });
        expect(none).not.toHaveProperty('projectId');
    });

    it('auto-restore after a daemon gap keeps the project', () => {
        const uuid = '11111111-2222-3333-4444-555555555555';
        const sel = selectAutoRestore([{ id: 't1', cwd: '/w', seenAt: 1000, claudeSessionId: uuid, projectId: PID }], {
            now: 1000, config: { enabled: true, max: 5, windowMs: 60_000 }, liveIds: new Set(), cwdExists: () => true,
        });
        expect(sel.plans[0]).toMatchObject({ terminalId: 't1', projectId: PID });
    });
});
