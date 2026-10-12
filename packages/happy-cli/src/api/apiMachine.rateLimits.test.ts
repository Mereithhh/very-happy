import { describe, expect, it, vi } from 'vitest';
import { ApiMachineClient } from './apiMachine';

const NOW = 1_791_800_000_000;
const report = (provider: 'claude' | 'codex', kind: string, usedPercent: number) => ({
    provider, observedAt: NOW, windows: [{ kind, usedPercent, resetsAt: NOW + 3_600_000, observedAt: NOW }],
});

describe('ApiMachineClient rate limits (B-555)', () => {
    const write = (ApiMachineClient.prototype as any).writeRateLimits;

    function fakeClient(state: any, connected = true) {
        const client: any = {
            socket: { connected },
            cliUpdatePushChain: Promise.resolve(),
            state,
            updateDaemonState(update: (s: any) => any) { client.state = update(client.state); return Promise.resolve(); },
        };
        return client;
    }

    it('merges into the freshest daemonState without dropping other fields or providers', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(NOW);
        try {
            const client = fakeClient({
                status: 'running', pid: 7, webTerminals: { updatedAt: 1, terminals: [] },
                rateLimits: { v: 1, updatedAt: 1, providers: { codex: { observedAt: NOW - 10, windows: [{ kind: 'seven_day', usedPercent: 3, resetsAt: null, observedAt: NOW - 10 }] } } },
            });
            await expect(write.call(client, [report('claude', 'five_hour', 42)])).resolves.toBe(true);
            expect(client.state).toMatchObject({ status: 'running', pid: 7, webTerminals: { updatedAt: 1 } });
            expect(Object.keys(client.state.rateLimits.providers).sort()).toEqual(['claude', 'codex']);
            expect(client.state.rateLimits.providers.claude.windows[0]).toMatchObject({ kind: 'five_hour', usedPercent: 42 });
        } finally { now.mockRestore(); }
    });

    it('does not write while the control socket is down', async () => {
        const client = fakeClient({ status: 'running' }, false);
        const spy = vi.spyOn(client, 'updateDaemonState');
        await expect(write.call(client, [report('claude', 'five_hour', 1)])).resolves.toBe(false);
        expect(spy).not.toHaveBeenCalled();
    });

    it('reports a failed write as false so the publisher keeps the observation', async () => {
        const client = fakeClient({ status: 'running' });
        client.updateDaemonState = () => Promise.reject(new Error('quota'));
        await expect(write.call(client, [report('claude', 'five_hour', 1)])).resolves.toBe(false);
    });
});
