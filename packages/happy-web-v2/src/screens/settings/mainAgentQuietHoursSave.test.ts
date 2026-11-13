// @vitest-environment happy-dom
/** B-924: quiet hours write into the main agent config KV with a version CAS and keep the other fields. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ kvMutate: vi.fn() }));
vi.mock('@/sync/apiKv', () => ({ kvMutate: h.kvMutate, kvGet: vi.fn() }));
const { saveMainAgentQuietHours } = await import('./MainAgentAutomationsSection');
const { useMainAgentStore } = await import('@/assistant/mainAgentStore');
const { decodeKvJson, encodeKvJson } = await import('@/assistant/mainAgent');

const creds = { token: 't', secret: 's' } as never;
const quiet = { enabled: true, start: '23:00', end: '07:00', tz: 'Asia/Tokyo' };

beforeEach(() => {
    h.kvMutate.mockReset();
    useMainAgentStore.getState().reset();
});

describe('saveMainAgentQuietHours (B-924)', () => {
    it('writes with the known version and keeps skillRoots / deniedTools / unknown fields', async () => {
        const raw = { v: 1, skillRoots: ['~/s'], deniedTools: [], extra: 'keep' };
        useMainAgentStore.setState({ configRaw: raw, configVersion: 3, configStatus: 'ready', config: { skillRoots: ['~/s'], deniedTools: [] } });
        const before = useMainAgentStore.getState().config;
        h.kvMutate.mockResolvedValueOnce({ success: true, results: [{ key: 'vh.main-agent-config.v1', version: 4 }] });
        expect(await saveMainAgentQuietHours(creds, quiet)).toBe(true);
        const [, mutations] = h.kvMutate.mock.calls[0];
        expect(mutations[0]).toMatchObject({ key: 'vh.main-agent-config.v1', version: 3 });
        expect(decodeKvJson(mutations[0].value)).toMatchObject({ skillRoots: ['~/s'], deniedTools: [], extra: 'keep', quietHours: quiet });
        const st = useMainAgentStore.getState();
        expect(st.configVersion).toBe(4);
        expect(st.config).toBe(before); // unchanged lists keep the same object (the page's drafts survive)
    });

    it('a version conflict re-merges onto the newer value once', async () => {
        useMainAgentStore.setState({ configRaw: null, configVersion: -1, configStatus: 'ready' });
        const newer = { v: 1, skillRoots: ['~/other'], deniedTools: ['x__y'] };
        h.kvMutate
            .mockResolvedValueOnce({ success: false, errors: [{ key: 'vh.main-agent-config.v1', error: 'version-mismatch', version: 7, value: encodeKvJson(newer) }] })
            .mockResolvedValueOnce({ success: true, results: [{ key: 'vh.main-agent-config.v1', version: 8 }] });
        expect(await saveMainAgentQuietHours(creds, quiet)).toBe(true);
        const [, second] = h.kvMutate.mock.calls[1];
        expect(second[0].version).toBe(7);
        expect(decodeKvJson(second[0].value)).toMatchObject({ skillRoots: ['~/other'], deniedTools: ['x__y'], quietHours: quiet });
        expect(useMainAgentStore.getState().config.skillRoots).toEqual(['~/other']);
    });

    it('gives up after a second conflict', async () => {
        h.kvMutate.mockResolvedValue({ success: false, errors: [{ key: 'vh.main-agent-config.v1', error: 'version-mismatch', version: 9, value: null }] });
        expect(await saveMainAgentQuietHours(creds, quiet)).toBe(false);
        expect(h.kvMutate).toHaveBeenCalledTimes(2);
    });
});

describe('B-924 (QA P1-4) default automations need a daemon that announces them', () => {
    it('mainAgentAutomationsSupported reads daemonState.mainAgentAutomations', async () => {
        const { mainAgentAutomationsSupported } = await import('./MainAgentAutomationsSection');
        expect(mainAgentAutomationsSupported(null)).toBe(false);
        expect(mainAgentAutomationsSupported({ daemonState: {} })).toBe(false);
        expect(mainAgentAutomationsSupported({ daemonState: { mainAgentSafety: { rpcAvailable: true, detectedAt: 1 } } })).toBe(false);
        expect(mainAgentAutomationsSupported({ daemonState: { mainAgentAutomations: { rpcAvailable: true, detectedAt: 1 } } })).toBe(true);
    });
});
