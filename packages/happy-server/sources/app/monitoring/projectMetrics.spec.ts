import { describe, expect, it } from 'vitest';
import { register } from 'prom-client';
import { countPeerMessage, countProjectOp, recordProjectUxEvent } from './projectMetrics';

const value = async (name: string, labels: Record<string, string>) => {
    const base = name.replace(/_count$/, '');
    const metric = (await register.getMetricsAsJSON()).find(m => m.name === base) as any;
    return metric?.values.find((v: any) => (v.metricName ?? base) === name && Object.entries(labels).every(([k, x]) => v.labels[k] === x))?.value ?? 0;
};

describe('B-651 project metrics', () => {
    it('counts ops with low-cardinality labels only', async () => {
        const before = await value('project_ops_total', { op: 'note_create', actor: 'agent' });
        countProjectOp('note_create', 'agent');
        countProjectOp('note_create', 'agent', 0);
        expect(await value('project_ops_total', { op: 'note_create', actor: 'agent' })).toBe(before + 1);
        const labelNames = new Set(((await register.getMetricsAsJSON()).find(m => m.name === 'project_ops_total') as any).values.flatMap((v: any) => Object.keys(v.labels)));
        expect([...labelNames].filter((l) => l !== 'app').sort()).toEqual(['actor', 'op']);
    });
    it('records dispatch entries and attention latency from web events', async () => {
        const d0 = await value('project_dispatch_total', { entry: 'project', in_project: 'yes' });
        recordProjectUxEvent({ kind: 'dispatch', entry: 'project', inProject: true });
        expect(await value('project_dispatch_total', { entry: 'project', in_project: 'yes' })).toBe(d0 + 1);
        const c0 = await value('attention_open_seconds_count', { in_project: 'no' });
        recordProjectUxEvent({ kind: 'attention_open', latencyMs: 90_000, inProject: false });
        expect(await value('attention_open_seconds_count', { in_project: 'no' })).toBe(c0 + 1);
    });
    it('counts only session-to-session messages (localId marker)', async () => {
        const p0 = await value('session_peer_messages_total', { in_project: 'yes' });
        countPeerMessage('session-message-abcd', true);
        countPeerMessage('web-123', true);
        countPeerMessage(undefined, true);
        expect(await value('session_peer_messages_total', { in_project: 'yes' })).toBe(p0 + 1);
    });
});
