import { describe, expect, it, vi } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

installBrowserTestGlobals();
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { machineRPC: vi.fn() } }));
const { renderToStaticMarkup } = await import('react-dom/server');
const { AgentVersionsGroup } = await import('./AgentVersionsGroup');

const now = 10_000_000;
const daemon = {
    pid: 7, agentVersionEpoch: 1,
    agentVersions: { checkedAt: now - 1000, daemonPid: 7, agents: [
        { id: 'pi', installed: null, latest: '1.3.0', status: 'not-installed' },
        { id: 'codex', installed: '0.154.0', latest: '0.163.0', status: 'update-available' },
    ] },
};

describe('machine page harness rows (B-719)', () => {
    it('online: Install / Update are enabled', () => {
        const html = renderToStaticMarkup(<AgentVersionsGroup daemon={daemon} online now={now} machineId="m1" metadata={{ harnessInstallVersion: 1 }} />);
        expect(html).toContain('>Install<');
        expect(html).toContain('>Update<');
        expect(html).not.toMatch(/<button[^>]*disabled[^>]*>[^<]*(Install|Update)</);
    });
    it('offline: rows stay visible but greyed, with the reason', () => {
        const html = renderToStaticMarkup(<AgentVersionsGroup daemon={daemon} online={false} now={now} machineId="m1" metadata={{ harnessInstallVersion: 1 }} />);
        expect(html).toContain('The machine is offline. Bring it online to install.');
        expect((html.match(/<button[^>]*disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(1);
    });
    it('old daemon: no Install button at all', () => {
        const html = renderToStaticMarkup(<AgentVersionsGroup daemon={daemon} online now={now} machineId="m1" metadata={{}} />);
        expect(html).not.toContain('>Install<');
    });
});
