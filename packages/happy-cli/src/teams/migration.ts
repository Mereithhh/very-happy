import { z } from 'zod';

const legacyTask = z.object({
    id: z.string().regex(/^T-\d{3,}$/), goal: z.string().min(1), cwd: z.string().min(1),
    acceptance: z.array(z.string().min(1)).min(1),
    status: z.enum(['queued', 'running', 'waiting', 'review', 'done', 'stopped', 'escalated']),
    sessionId: z.string().nullable().optional(), agent: z.string().optional(),
});
const ledger = z.object({ version: z.literal(1), tasks: z.array(legacyTask) });

/** Offline assessment only: a legacy review/idle state is never imported as accepted work. */
export function previewLegacyTeamsMigration(input: unknown) {
    const parsed = ledger.parse(input);
    if (new Set(parsed.tasks.map(t => t.id)).size !== parsed.tasks.length) throw new Error('Duplicate legacy task ids');
    return {
        mode: 'preview-only' as const,
        precondition: 'Stop and verify the old dispatcher before creating any replacement assignment. Preserve the original ledger as an audit archive.',
        tasks: parsed.tasks.map(task => {
            const assistant = task.agent === 'pi' ? 'pi-acp' : task.agent ?? 'claude';
            const supported = ['claude', 'codex', 'pi-acp'].includes(assistant);
            const closed = ['done', 'stopped'].includes(task.status);
            return {
                legacyId: task.id, goal: task.goal, legacyStatus: task.status, sessionId: task.sessionId ?? null,
                disposition: closed ? 'retain-history' : task.sessionId ? 'reconcile-existing-session' : supported ? 'ready-after-dispatcher-stopped' : 'unsupported-runner',
                ...(closed || task.sessionId || !supported ? {} : { proposedAction: { type: 'delegate', goal: task.goal, acceptance: task.acceptance, directory: task.cwd, assistant } }),
            };
        }),
    };
}
