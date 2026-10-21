import { register, Counter, Histogram } from 'prom-client';
import type { ProjectUxEvent } from '@slopus/happy-wire';

/**
 * B-651 project metrics (`specs/2026-10-projects.md` 度量). Low-cardinality
 * labels only — never account, project or session ids.
 *
 * ① dispatch interactions  → project_dispatch_total{entry, in_project}
 * ② 等你处理 → opened       → attention_open_seconds{in_project}
 * ③ peer-induced turns      → session_peer_messages_total{in_project} (token share: scripts/dev/project-metrics.mjs)
 * ④ project_context usage   → project_ops_total{op="context_read"} (per-session median: the script)
 */
const reuse = <T>(name: string, make: () => T): T => (register.getSingleMetric(name) as T | undefined) ?? make();

export const projectOpsCounter = reuse('project_ops_total', () => new Counter({
    name: 'project_ops_total',
    help: 'Project operations by kind and actor (user = web/CLI owner, agent = a session via its wrapper, daemon)',
    labelNames: ['op', 'actor'] as const,
    registers: [register],
}));

export const projectDispatchCounter = reuse('project_dispatch_total', () => new Counter({
    name: 'project_dispatch_total',
    help: 'Sessions created or moved, by entry point and whether they landed in a project (web-reported)',
    labelNames: ['entry', 'in_project'] as const,
    registers: [register],
}));

export const attentionOpenHistogram = reuse('attention_open_seconds', () => new Histogram({
    name: 'attention_open_seconds',
    help: 'Time from a session starting to wait for the owner until the owner opened it (web-reported)',
    labelNames: ['in_project'] as const,
    buckets: [5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21600, 86400],
    registers: [register],
}));

export const sessionPeerMessagesCounter = reuse('session_peer_messages_total', () => new Counter({
    name: 'session_peer_messages_total',
    help: 'Session-to-session messages written into a session (each starts a turn or queues one)',
    labelNames: ['in_project'] as const,
    registers: [register],
}));

export type ProjectOp =
    | 'create' | 'member_add' | 'member_remove' | 'instructions_put' | 'instructions_conflict'
    | 'note_create' | 'note_quota_refused' | 'note_revoke' | 'context_read' | 'digest_read' | 'digest_nonempty'
    | 'message_stored' | 'message_delivered' | 'presence_write' | 'team_attach';

export function countProjectOp(op: ProjectOp, actor: 'user' | 'agent' | 'daemon' = 'user', by = 1): void {
    if (by > 0) projectOpsCounter.inc({ op, actor }, by);
}

export function recordProjectUxEvent(event: ProjectUxEvent): void {
    const in_project = event.inProject ? 'yes' : 'no';
    if (event.kind === 'dispatch') projectDispatchCounter.inc({ entry: event.entry, in_project });
    else attentionOpenHistogram.observe({ in_project }, event.latencyMs / 1000);
}

/** ③: a session-to-session message (plaintext marker: its localId prefix) written into a session. */
export function countPeerMessage(localId: string | null | undefined, inProject: boolean): void {
    if (localId?.startsWith('session-message-')) sessionPeerMessagesCounter.inc({ in_project: inProject ? 'yes' : 'no' });
}
