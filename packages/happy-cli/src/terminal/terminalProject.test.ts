import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedTmux, tmuxAvailable } from '@/testing/isolatedTmux';

// The kill-path cases drive a real WebTerminalManager: isolated HAPPY_HOME_DIR
// (closed-terminals.json) and a private tmux socket BEFORE webTerminal loads.
const happyHome = mkdtempSync(join(tmpdir(), 'vh-proj-home-'));
const prevHome = process.env.HAPPY_HOME_DIR;
process.env.HAPPY_HOME_DIR = happyHome;
const iso = createIsolatedTmux('vh-proj');
const { parseTerminalProjectId, validateTerminalProjectId } = await import('./terminalProject');
const { LIST_FIELD_SEP, parseSessionListLine, terminalListSignature, WebTerminalManager } = await import('./webTerminal');
type TerminalListItem = import('./webTerminal').TerminalListItem;
const { liveSnapshotChanged, sanitizeLiveSnapshot } = await import('./liveTerminals');
const { sanitizeClosedTerminals } = await import('./closedTerminals');
const { planTerminalRestore } = await import('./terminalRestore');
const { selectAutoRestore } = await import('./autoRestore');

afterAll(() => {
    iso.dispose();
    if (prevHome === undefined) delete process.env.HAPPY_HOME_DIR; else process.env.HAPPY_HOME_DIR = prevHome;
    rmSync(happyHome, { recursive: true, force: true });
});

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

    // B-868b (QA39 P1): the web ⋯ → Close path wrote a close record WITHOUT the
    // project, so ↻ restore came back as "not in a project". Every close path
    // must carry it; tracking / daemon-gap / auto-restore are covered above.
    describe.skipIf(!tmuxAvailable)('web close (killSession) keeps the project for ↻ restore', () => {
        const mgr = new WebTerminalManager(() => { /* stream not under test */ });
        afterAll(() => { mgr.disposeAll(); mgr.stopListTracking(); });
        const vhProject = (id: string) => (iso.run('show-options', '-qv', '-t', `=vh-${id}:`, '@vh_project').stdout ?? '').trim();

        it('tmux terminal: close record has projectId, restore puts @vh_project back', async () => {
            await mgr.open({ terminalId: 'proj0001', cols: 80, rows: 24, cwd: iso.dir, projectId: PID });
            mgr.unsubscribe('proj0001');
            expect(vhProject('proj0001')).toBe(PID);
            expect(mgr.killSession('proj0001')).toBe(true);
            expect(iso.hasSession('vh-proj0001')).toBe(false);
            expect(mgr.getClosedTerminals().find((r) => r.id === 'proj0001')).toMatchObject({ reason: 'closed', projectId: PID });
            expect(mgr.restoreClosedTerminal('proj0001')).toEqual({ type: 'success', terminalId: 'proj0001' });
            expect(vhProject('proj0001')).toBe(PID);
            expect(mgr.listSessions().find((t) => t.id === 'proj0001')?.projectId).toBe(PID);
        }, 30_000);

        it('tmux terminal moved into a project after creation: the close record follows the move', async () => {
            await mgr.open({ terminalId: 'proj0002', cols: 80, rows: 24, cwd: iso.dir });
            mgr.unsubscribe('proj0002');
            expect(mgr.setProject('proj0002', PID)).toBe(true);
            expect(mgr.killSession('proj0002')).toBe(true);
            expect(mgr.getClosedTerminals().find((r) => r.id === 'proj0002')?.projectId).toBe(PID);
        }, 30_000);

        it('direct pty: close record has projectId', () => {
            // The direct branch is chosen by tmux absence; seed the live session it keys on.
            (mgr as any).terminals.set('proj0003', { direct: { cwd: iso.dir, createdAt: 1, tags: [], projectId: PID }, dispose: () => {} });
            expect(mgr.killSession('proj0003')).toBe(true);
            expect(mgr.getClosedTerminals().find((r) => r.id === 'proj0003')).toMatchObject({ reason: 'closed', cwd: iso.dir, projectId: PID });
        });
    });
});
