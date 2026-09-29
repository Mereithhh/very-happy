import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadSettings, mockProbe } = vi.hoisted(() => ({
    mockReadSettings: vi.fn(),
    mockProbe: vi.fn(),
}));

vi.mock('@/persistence', () => ({ readSettings: mockReadSettings }));
vi.mock('./loginShellEnv', () => ({ probeLoginShellEnv: mockProbe }));

import {
    AGENT_HOME_CACHE_MS,
    AGENT_HOME_FAILURE_CACHE_MS,
    AGENT_HOME_MAX_STALE_MS,
    decideShellProbe,
    refreshAgentHomes,
    resetAgentHomesCache,
} from './index';

describe('decideShellProbe (B-512)', () => {
    const t0 = 1_000_000;
    const ok = { probedAt: t0, ttlMs: AGENT_HOME_CACHE_MS };

    it('probes when nothing is cached', () => {
        expect(decideShellProbe(null, t0, true)).toBe('await-probe');
        expect(decideShellProbe(null, t0, false)).toBe('await-probe');
    });

    it('uses the cache within its TTL for every caller', () => {
        expect(decideShellProbe(ok, t0 + AGENT_HOME_CACHE_MS - 1, false)).toBe('use-cached');
        expect(decideShellProbe(ok, t0 + AGENT_HOME_CACHE_MS - 1, true)).toBe('use-cached');
    });

    it('serves stale (and revalidates) only for spawns, and only up to the stale cap', () => {
        expect(decideShellProbe(ok, t0 + AGENT_HOME_CACHE_MS, true)).toBe('use-stale-and-revalidate');
        expect(decideShellProbe(ok, t0 + AGENT_HOME_MAX_STALE_MS - 1, true)).toBe('use-stale-and-revalidate');
        expect(decideShellProbe(ok, t0 + AGENT_HOME_MAX_STALE_MS, true)).toBe('await-probe');
    });

    it('resume / restart / daemon start (no allowStale) keep waiting for a fresh probe', () => {
        expect(decideShellProbe(ok, t0 + AGENT_HOME_CACHE_MS, false)).toBe('await-probe');
    });

    it('a failed probe is trusted for its own (longer) TTL', () => {
        const failed = { probedAt: t0, ttlMs: AGENT_HOME_FAILURE_CACHE_MS };
        expect(decideShellProbe(failed, t0 + AGENT_HOME_CACHE_MS, false)).toBe('use-cached');
    });
});

describe.skipIf(process.platform === 'win32')('refreshAgentHomes stale-while-revalidate (B-512)', () => {
    const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };

    beforeEach(() => {
        resetAgentHomesCache();
        delete process.env.CLAUDE_CONFIG_DIR;
        delete process.env.CODEX_HOME;
        mockReadSettings.mockReset();
        mockProbe.mockReset();
        mockReadSettings.mockResolvedValue({});
    });
    afterEach(() => {
        resetAgentHomesCache();
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    });

    it('a spawn serves the expired shell answer, re-probes in the background, and the next call sees it', async () => {
        const t0 = 5_000_000;
        mockProbe.mockResolvedValueOnce({ CLAUDE_CONFIG_DIR: '/shell/old' });
        expect((await refreshAgentHomes(t0)).claudeConfigDir.path).toBe('/shell/old');

        let finishProbe!: (env: Record<string, string>) => void;
        mockProbe.mockReturnValueOnce(new Promise((resolve) => { finishProbe = resolve; }));
        const stale = await refreshAgentHomes(t0 + AGENT_HOME_CACHE_MS + 1, { allowStale: true });
        expect(stale.claudeConfigDir.path).toBe('/shell/old');
        expect(mockProbe).toHaveBeenCalledTimes(2); // background refresh started

        finishProbe({ CLAUDE_CONFIG_DIR: '/shell/new' });
        await vi.waitFor(async () => {
            expect((await refreshAgentHomes(t0 + AGENT_HOME_CACHE_MS + 2, { allowStale: true })).claudeConfigDir.path).toBe('/shell/new');
        });
        expect(mockProbe).toHaveBeenCalledTimes(2);
    });

    it('resume/restart callers wait for the fresh probe', async () => {
        const t0 = 6_000_000;
        mockProbe.mockResolvedValueOnce({ CLAUDE_CONFIG_DIR: '/shell/old' });
        await refreshAgentHomes(t0);
        mockProbe.mockResolvedValueOnce({ CLAUDE_CONFIG_DIR: '/shell/new' });
        expect((await refreshAgentHomes(t0 + AGENT_HOME_CACHE_MS + 1)).claudeConfigDir.path).toBe('/shell/new');
    });

    it('a spawn waits once the answer is older than the stale cap', async () => {
        const t0 = 7_000_000;
        mockProbe.mockResolvedValueOnce({ CLAUDE_CONFIG_DIR: '/shell/old' });
        await refreshAgentHomes(t0);
        mockProbe.mockResolvedValueOnce({ CLAUDE_CONFIG_DIR: '/shell/new' });
        const homes = await refreshAgentHomes(t0 + AGENT_HOME_MAX_STALE_MS, { allowStale: true });
        expect(homes.claudeConfigDir.path).toBe('/shell/new');
    });

    it('re-reads settings on every call, even while the shell answer is cached', async () => {
        const t0 = 8_000_000;
        mockProbe.mockResolvedValue({ CLAUDE_CONFIG_DIR: '/shell/dir' });
        await refreshAgentHomes(t0);
        mockReadSettings.mockResolvedValue({ claudeConfigDir: '/pinned/in/settings' });
        const homes = await refreshAgentHomes(t0 + 1, { allowStale: true });
        expect(homes.claudeConfigDir.path).toBe('/pinned/in/settings');
        expect(process.env.CLAUDE_CONFIG_DIR).toBe('/pinned/in/settings');
        expect(mockProbe).toHaveBeenCalledTimes(1);
        expect(mockReadSettings).toHaveBeenCalledTimes(2);
    });

    it('a rejected background probe is contained and the stale answer keeps serving', async () => {
        const t0 = 9_000_000;
        mockProbe.mockResolvedValueOnce({ CLAUDE_CONFIG_DIR: '/shell/old' });
        await refreshAgentHomes(t0);
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            mockProbe.mockRejectedValueOnce(new Error('shell exploded'));
            const homes = await refreshAgentHomes(t0 + AGENT_HOME_CACHE_MS + 1, { allowStale: true });
            expect(homes.claudeConfigDir.path).toBe('/shell/old');
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });
});
