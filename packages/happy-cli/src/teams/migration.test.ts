import { describe, expect, it } from 'vitest';
import { previewLegacyTeamsMigration } from './migration';
const base = { goal: 'g', cwd: '/repo', acceptance: ['tested'], agent: 'codex' };
describe('legacy team migration preview', () => {
    it('never respawns existing sessions or turns legacy review into accepted work', () => {
        const result = previewLegacyTeamsMigration({ version: 1, tasks: [
            { ...base, id: 'T-001', status: 'review', sessionId: 'live-session' },
            { ...base, id: 'T-002', status: 'done' },
            { ...base, id: 'T-003', status: 'queued' },
            { ...base, id: 'T-004', status: 'queued', agent: 'gemini' },
        ] });
        expect(result.mode).toBe('preview-only');
        expect(result.tasks.map(t => t.disposition)).toEqual(['reconcile-existing-session', 'retain-history', 'ready-after-dispatcher-stopped', 'unsupported-runner']);
        expect(result.tasks[0]).not.toHaveProperty('proposedAction');
        expect(result.tasks[1]).not.toHaveProperty('proposedAction');
        expect(result.tasks[2].proposedAction).toMatchObject({ type: 'delegate', assistant: 'codex' });
    });
    it('rejects unsupported versions and duplicate identities before producing a plan', () => {
        expect(() => previewLegacyTeamsMigration({ version: 2, tasks: [] })).toThrow();
        const t = { ...base, id: 'T-001', status: 'queued' };
        expect(() => previewLegacyTeamsMigration({ version: 1, tasks: [t, t] })).toThrow('Duplicate');
    });
});
