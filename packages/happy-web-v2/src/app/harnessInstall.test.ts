import { describe, expect, it, vi } from 'vitest';

const machineRPC = vi.fn();
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { machineRPC: (...args: unknown[]) => machineRPC(...args) } }));
const { machineCanInstallHarness, readHarnessInstall, requestHarnessInstall, HARNESS_INSTALL_STALE_MS } = await import('./harnessInstall');

describe('harness install on the Web (B-719)', () => {
    it('offers Install only on an online daemon that serves the RPC', () => {
        expect(machineCanInstallHarness({ harnessInstallVersion: 1 }, true)).toBe(true);
        expect(machineCanInstallHarness({ harnessInstallVersion: 1 }, false)).toBe(false);
        expect(machineCanInstallHarness({}, true)).toBe(false);
        expect(machineCanInstallHarness(null, true)).toBe(false);
    });

    it('sends only the harness id', async () => {
        machineRPC.mockResolvedValueOnce({ accepted: true, harness: 'pi' });
        expect(await requestHarnessInstall('m1', 'pi')).toEqual({ ok: true });
        expect(machineRPC).toHaveBeenLastCalledWith('m1', 'harness-install', { harness: 'pi' });
    });

    it('maps daemon refusals and transport failures', async () => {
        machineRPC.mockResolvedValueOnce({ error: 'install_location_not_writable' });
        expect(await requestHarnessInstall('m1', 'codex')).toEqual({ ok: false, error: 'install_location_not_writable' });
        machineRPC.mockResolvedValueOnce({ error: 'something new' });
        expect(await requestHarnessInstall('m1', 'codex')).toEqual({ ok: false, error: 'request_failed' });
        machineRPC.mockRejectedValueOnce(new Error('offline'));
        expect(await requestHarnessInstall('m1', 'codex')).toEqual({ ok: false, error: 'request_failed' });
    });

    it('reads progress, keeps the failure reason, and expires a silent install', () => {
        const base = { harness: 'pi', startedAt: 1000, at: 1000 };
        expect(readHarnessInstall({ harnessInstall: { ...base, state: 'installing' } }, 2000)).toEqual({ harness: 'pi', state: 'installing', detail: null, at: 1000 });
        expect(readHarnessInstall({ harnessInstall: { ...base, state: 'failed', detail: 'npm_exit_1: EACCES' } }, 2000)?.detail).toBe('npm_exit_1: EACCES');
        expect(readHarnessInstall({ harnessInstall: { ...base, state: 'installing' } }, 1000 + HARNESS_INSTALL_STALE_MS + 1)).toMatchObject({ state: 'failed', detail: 'stale' });
        expect(readHarnessInstall({ harnessInstall: { ...base, harness: 'evil', state: 'installed' } })).toBeNull();
        expect(readHarnessInstall(null)).toBeNull();
    });
});
