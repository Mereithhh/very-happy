import { describe, expect, it } from 'vitest';
import { planTerminalRestore, TERMINAL_ID_RE } from './terminalRestore';

const uuid = 'c0c26854-5e0c-4063-aaeb-d4428fe8ed94';
const facts = { tmuxAlive: false, cwdExists: () => true, conversationExists: () => true };
const rec = { id: 'abc123', title: 'work', cwd: '/w', tags: ['a', 'b'], manual: true, claudeSessionId: uuid, closedAt: 1 };

describe('B-265 planTerminalRestore', () => {
    it('recreates the same id/cwd/title/manual/tags and resumes the recorded conversation', () => {
        expect(planTerminalRestore(rec, facts)).toEqual({
            kind: 'create', terminalId: 'abc123', cwd: '/w', title: 'work', manual: true, tags: ['a', 'b'], command: `claude --resume ${uuid}`,
        });
    });
    it('B-287: carries the recorded pane geometry into the create plan (both branches)', () => {
        expect(planTerminalRestore({ ...rec, cols: 200, rows: 50 }, facts)).toMatchObject({ kind: 'create', cols: 200, rows: 50 });
        // absent geometry → no cols/rows keys (daemon falls back to its default)
        const p = planTerminalRestore(rec, facts) as any;
        expect('cols' in p).toBe(false);
        const att = { id: 'att1', cwd: '/w', manual: true, attachTmux: 'my dev', cols: 146, rows: 40, closedAt: 1 };
        expect(planTerminalRestore(att, { ...facts, userSessions: [{ id: '$4', name: 'my dev' }] })).toMatchObject({ kind: 'create', cols: 146, rows: 40 });
    });
    it('no command without a valid uuid or without the JSONL on disk; manual defaults to false', () => {
        expect(planTerminalRestore({ ...rec, claudeSessionId: undefined, manual: undefined }, facts)).toMatchObject({ kind: 'create', manual: false });
        expect('command' in planTerminalRestore({ ...rec, claudeSessionId: '../x' }, facts)).toBe(false);
        expect('command' in planTerminalRestore(rec, { ...facts, conversationExists: () => false })).toBe(false);
    });
    it('is idempotent on a live tmux session and refuses a missing cwd', () => {
        expect(planTerminalRestore(rec, { ...facts, tmuxAlive: true })).toEqual({ kind: 'already-live' });
        expect(planTerminalRestore({ ...rec, cwd: undefined }, facts)).toEqual({ kind: 'error', reason: 'missing-cwd' });
        expect(planTerminalRestore(rec, { ...facts, cwdExists: () => false })).toEqual({ kind: 'error', reason: 'missing-cwd' });
    });
    it('B-273: an attach terminal comes back attached (unique live name → $id) or not at all', () => {
        const att = { id: 'att1', title: 'my dev', cwd: '/w', manual: true, attachTmux: 'my dev', closedAt: 1 };
        const live = [{ id: '$4', name: 'my dev' }, { id: '$9', name: 'other' }];
        expect(planTerminalRestore(att, { ...facts, userSessions: live })).toEqual({
            kind: 'create', terminalId: 'att1', cwd: '/w', title: 'my dev', manual: true, tags: undefined,
            command: " TMUX= tmux attach-session -t '$4'", attachTmux: 'my dev',
        });
        expect(planTerminalRestore(att, { ...facts, userSessions: live, attachSocket: '/tmp/s' })).toMatchObject({ command: " TMUX= tmux -S '/tmp/s' attach-session -t '$4'" });
        expect(planTerminalRestore(att, { ...facts, userSessions: [] })).toEqual({ kind: 'error', reason: 'tmux-session-gone' });
        expect(planTerminalRestore(att, { ...facts })).toEqual({ kind: 'error', reason: 'tmux-session-gone' });
        expect(planTerminalRestore(att, { ...facts, userSessions: [...live, { id: '$5', name: 'my dev' }] })).toEqual({ kind: 'error', reason: 'tmux-session-gone' }); // ambiguous
        // A vanished cwd falls back to the home directory (irrelevant inside the attached session).
        expect(planTerminalRestore(att, { ...facts, userSessions: live, cwdExists: () => false, homeDir: '/home/u' })).toMatchObject({ kind: 'create', cwd: '/home/u' });
        expect(planTerminalRestore(att, { ...facts, userSessions: live, cwdExists: () => false })).toEqual({ kind: 'error', reason: 'missing-cwd' });
        // Never resumes a claude conversation on top of an attach record.
        expect('command' in planTerminalRestore({ ...att, claudeSessionId: uuid }, { ...facts, userSessions: live }) && (planTerminalRestore({ ...att, claudeSessionId: uuid }, { ...facts, userSessions: live }) as any).command.includes('claude')).toBe(false);
    });
    it('terminal ids are charset-limited (they become tmux target names)', () => {
        expect(TERMINAL_ID_RE.test('ok_id-1')).toBe(true);
        expect(TERMINAL_ID_RE.test('=vh-x:')).toBe(false);
        expect(TERMINAL_ID_RE.test('')).toBe(false);
    });
});
