import { describe, expect, it, vi } from 'vitest';
import type { HarnessInstallState } from '@slopus/happy-wire';
import { createHarnessInstaller, summarizeNpmFailure } from './harnessInstaller';
import { HARNESS_INSTALL_CATALOG, harnessInstallArgs, harnessInstallCommand } from './installCatalog';

const PKG = '/home/u/.npm-global/lib/node_modules/very-happy-cli';
function setup(over: Partial<Parameters<typeof createHarnessInstaller>[0]> = {}) {
    const published: HarnessInstallState[] = [];
    const logs: string[] = [];
    const onPath = new Set<string>();
    const deps = {
        npm: vi.fn(async (_args: string[]) => { onPath.add('pi'); onPath.add('pi-acp'); return { code: 0, stdout: '' }; }),
        runningPackageDir: PKG,
        commandOnPath: (c: string) => onPath.has(c),
        cliUpdateBusy: () => false,
        publish: (s: HarnessInstallState) => { published.push(s); },
        afterInstall: vi.fn(async () => undefined),
        log: (m: string) => { logs.push(m); },
        canWrite: async () => true,
        isPlainDirectory: async () => true,
        now: () => 1000,
        ...over,
    };
    return { deps, published, logs, onPath, installer: createHarnessInstaller(deps) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('harness install whitelist (B-719)', () => {
    it('maps each id to fixed packages and a no-shell npm argv in the CLI prefix', () => {
        expect(harnessInstallArgs('pi', '/home/u/.npm-global')).toEqual(['i', '-g', '--prefix=/home/u/.npm-global', '--no-fund', '--no-audit', '@earendil-works/pi-coding-agent@latest', 'pi-acp@0.0.33']);
        expect(harnessInstallArgs('codex', '/p')).toContain('@openai/codex@latest');
        expect(harnessInstallCommand('gemini')).toBe('npm install -g @google/gemini-cli@latest');
        expect(Object.keys(HARNESS_INSTALL_CATALOG).sort()).toEqual(['claude', 'codex', 'gemini', 'pi']);
    });
    it('refuses a prefix that could smuggle arguments', () => {
        expect(() => harnessInstallArgs('pi', '/tmp/x y')).toThrow();
        expect(() => harnessInstallArgs('pi', '/tmp/x;rm')).toThrow();
    });
});

describe('createHarnessInstaller (B-719)', () => {
    it('installs pi on request, re-probes, publishes installing → installed and logs it', async () => {
        const { installer, deps, published, logs } = setup();
        expect(await installer.request({ harness: 'pi' })).toEqual({ accepted: true, harness: 'pi' });
        await settle(); await settle();
        expect(deps.npm).toHaveBeenCalledWith(['i', '-g', '--prefix=/home/u/.npm-global', '--no-fund', '--no-audit', '@earendil-works/pi-coding-agent@latest', 'pi-acp@0.0.33']);
        expect(deps.afterInstall).toHaveBeenCalledTimes(1);
        expect(published.map((p) => p.state)).toEqual(['installing', 'installed']);
        expect(logs.some((l) => l.includes('owner requested pi install'))).toBe(true);
    });

    it('rejects package names, commands and anything outside the enum before npm runs', async () => {
        const { installer, deps, published } = setup();
        for (const bad of [{ harness: '@openai/codex' }, { harness: 'pi-acp' }, { harness: 'pi; rm -rf ~' }, { harness: 'opencode' }, { package: 'evil' }, 'pi', null]) {
            expect(await installer.request(bad)).toEqual({ error: 'unknown_harness' });
        }
        expect(deps.npm).not.toHaveBeenCalled();
        expect(published).toEqual([]);
    });

    it('never uses sudo or another prefix: an unwritable or unrecognised location is refused', async () => {
        const notWritable = setup({ canWrite: async () => false });
        expect(await notWritable.installer.request({ harness: 'codex' })).toEqual({ error: 'install_location_not_writable' });
        const dev = setup({ runningPackageDir: '/repo/packages/happy-cli' });
        expect(await dev.installer.request({ harness: 'codex' })).toEqual({ error: 'install_location_unverified' });
        expect(notWritable.deps.npm).not.toHaveBeenCalled();
        expect(dev.deps.npm).not.toHaveBeenCalled();
    });

    it('one at a time, and never while the CLI updates itself', async () => {
        let release!: () => void;
        const { installer } = setup({ npm: vi.fn(() => new Promise<{ code: number; stdout: string }>((r) => { release = () => r({ code: 0, stdout: '' }); })) });
        expect(installer.isRunning()).toBe(false);
        await installer.request({ harness: 'pi' });
        expect(installer.isRunning()).toBe(true);
        expect(await installer.request({ harness: 'codex' })).toEqual({ error: 'install_in_progress' });
        release(); await settle(); await settle();
        expect(installer.isRunning()).toBe(false);
        const busy = setup({ cliUpdateBusy: () => true });
        expect(await busy.installer.request({ harness: 'pi' })).toEqual({ error: 'cli_update_in_progress' });
    });

    it('reports npm failures with a short, sanitised reason', async () => {
        const { installer, published, deps } = setup({
            npm: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'npm error code EACCES\nnpm error path /home/alice/.npm-global/lib\nnpm error //registry/:_authToken=secret123\n' })),
        });
        await installer.request({ harness: 'gemini' }); await settle(); await settle();
        const last = published.at(-1)!;
        expect(last.state).toBe('failed');
        expect(last.detail).toMatch(/^npm_exit_1: .*EACCES/);
        expect(last.detail).not.toContain('alice');
        expect(last.detail).not.toContain('secret123');
        expect(deps.afterInstall).not.toHaveBeenCalled();
    });

    it('fails visibly when npm succeeded but the commands are not on the daemon PATH', async () => {
        const { installer, published } = setup({ npm: vi.fn(async () => ({ code: 0, stdout: '' })) });
        await installer.request({ harness: 'pi' }); await settle(); await settle();
        expect(published.at(-1)).toMatchObject({ state: 'failed', detail: 'not_on_path: pi, pi-acp' });
    });

    it('a timed-out npm is a failure, not a success', () => {
        expect(summarizeNpmFailure({ code: null, stdout: '' })).toBe('npm_timeout');
    });
});
