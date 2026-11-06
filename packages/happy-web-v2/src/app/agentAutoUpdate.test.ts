import { describe, expect, it } from 'vitest';
import { codexOutdatedNotice, readMachineAgentAutoUpdate } from './agentAutoUpdate';

const NOW = 1_800_000_000_000;
const daemon = (over: Record<string, unknown> = {}, codex = { id: 'codex', installed: '0.154.0', latest: '0.167.0', status: 'update-available' }) => ({
    pid: 7, startedAt: NOW - 1000, agentVersionEpoch: NOW - 2000,
    agentVersions: { checkedAt: NOW - 500, daemonPid: 7, agents: [codex] },
    ...over,
});

describe('B-894 readMachineAgentAutoUpdate', () => {
    it('absent on old daemons, trusted only from this daemon run', () => {
        expect(readMachineAgentAutoUpdate(daemon())).toBeNull();
        expect(readMachineAgentAutoUpdate(daemon({ agentAutoUpdate: { enabled: true, rpcAvailable: true, detectedAt: NOW - 5000 } }))).toBeNull();
        expect(readMachineAgentAutoUpdate(daemon({ agentAutoUpdate: { enabled: false, rpcAvailable: true, detectedAt: NOW, status: {} } })))
            .toEqual({ enabled: false, status: {} });
    });
    it('keeps the published outcome (failure shown, not dropped)', () => {
        const au = readMachineAgentAutoUpdate(daemon({ agentAutoUpdate: { enabled: true, rpcAvailable: true, detectedAt: NOW,
            status: { codex: { harness: 'codex', target: '0.167.0', state: 'gave-up', detail: 'npm_exit_1', attempts: 2, at: NOW }, bad: { state: 1 } } } }));
        expect(au?.status).toEqual({ codex: { harness: 'codex', target: '0.167.0', state: 'gave-up', detail: 'npm_exit_1', attempts: 2, at: NOW } });
    });
});

describe('B-894 codexOutdatedNotice (new session)', () => {
    it('shows when Codex is behind and auto-update is off or unsupported', () => {
        expect(codexOutdatedNotice(daemon(), NOW)).toEqual({ installed: '0.154.0', latest: '0.167.0' });
        expect(codexOutdatedNotice(daemon({ agentAutoUpdate: { enabled: false, rpcAvailable: true, detectedAt: NOW } }), NOW)).not.toBeNull();
    });
    it('hidden when the machine updates it by itself, when current, or when the check is stale', () => {
        expect(codexOutdatedNotice(daemon({ agentAutoUpdate: { enabled: true, rpcAvailable: true, detectedAt: NOW } }), NOW)).toBeNull();
        expect(codexOutdatedNotice(daemon({}, { id: 'codex', installed: '0.167.0', latest: '0.167.0', status: 'current' }), NOW)).toBeNull();
        expect(codexOutdatedNotice(daemon(), NOW + 13 * 3600_000)).toBeNull();
        expect(codexOutdatedNotice(null, NOW)).toBeNull();
    });
});
