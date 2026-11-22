import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    agentChildEnv,
    agentSpawnPathEnv,
    relaunchAgentPathEnv,
    rememberAgentBins,
    resetRememberedAgentBins,
    resolveAgentBins,
    versionManagerBinDirs,
    type AgentBinProbes,
} from './agentBinResolver';
import { withResolvedAgentBins, type CLIAvailability } from './detectCLI';
import { spawnAgentUnavailableError } from '@/daemon/spawnAgentAvailability';

const HOME = '/home/u';
const NVM = `${HOME}/.nvm/versions/node`;

/** A fake filesystem: executables by full path, dirs by listing, node versions by node path. */
function fakeProbes(opts: { executables: string[]; dirs?: Record<string, string[]>; nodes?: Record<string, string>; loginPath?: string | null }): AgentBinProbes & { loginCalls: number } {
    const executables = new Set(opts.executables);
    const probes = {
        loginCalls: 0,
        isExecutable: async (path: string) => executables.has(path),
        listDir: async (dir: string) => opts.dirs?.[dir] ?? [],
        nodeVersion: async (nodePath: string) => opts.nodes?.[nodePath] ?? null,
        loginShellPath: async () => { probes.loginCalls++; return opts.loginPath ?? null; },
    };
    return probes;
}

const ctx = (env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }) => ({ home: HOME, env, platform: 'linux' as const });

const BASE: CLIAvailability = { claude: true, codex: true, gemini: false, openclaw: false, pi: false, dsh: false, detectedAt: 1 };

afterEach(() => resetRememberedAgentBins());

describe('B-956: resolveAgentBins finds CLIs outside the daemon PATH', () => {
    it('the reported case: dsh installed under nvm Node 24, daemon PATH has Node 22 and no dsh → available, runs on the node next to it', async () => {
        const probes = fakeProbes({
            executables: ['/usr/bin/node', `${NVM}/v24.22.3/bin/node`, `${NVM}/v24.22.3/bin/dsh`, `${NVM}/v22.1.0/bin/node`],
            dirs: { [NVM]: ['v22.1.0', 'v24.22.3'] },
            nodes: { '/usr/bin/node': 'v22.23.2', [`${NVM}/v24.22.3/bin/node`]: 'v24.22.3' },
        });
        const resolved = await resolveAgentBins(ctx(), probes);
        expect(resolved.dsh).toEqual({ dir: `${NVM}/v24.22.3/bin`, nodeVersion: 'v24.22.3', extraPath: [`${NVM}/v24.22.3/bin`] });

        const availability = withResolvedAgentBins(BASE, resolved);
        expect(availability).toMatchObject({ dsh: true, dshNode: 'v24.22.3', dshPath: `${NVM}/v24.22.3/bin` });
        expect(spawnAgentUnavailableError('dsh', availability)).toBeNull();

        rememberAgentBins(resolved);
        // The daemon hands the dir to the wrapper; only the agent child gets it in front of PATH.
        const wrapperEnv = { PATH: '/usr/bin:/bin', ...agentSpawnPathEnv('dsh') };
        expect(wrapperEnv).toEqual({ PATH: '/usr/bin:/bin', VH_AGENT_PATH_PREPEND: `${NVM}/v24.22.3/bin` });
        expect(agentChildEnv(wrapperEnv)).toEqual({ PATH: `${NVM}/v24.22.3/bin:/usr/bin:/bin` });
        expect(agentSpawnPathEnv('claude')).toEqual({});
        expect(agentSpawnPathEnv('codex')).toEqual({});
        const plain = { PATH: '/usr/bin' };
        expect(agentChildEnv(plain)).toBe(plain);
    });

    it('dsh on the daemon PATH with an old node, a working copy under nvm → the nvm copy wins (no daemon restart, no PATH fiddling)', async () => {
        const probes = fakeProbes({
            executables: ['/usr/bin/node', '/usr/bin/dsh', `${NVM}/v24.9.0/bin/node`, `${NVM}/v24.9.0/bin/dsh`],
            dirs: { [NVM]: ['v24.9.0'] },
            nodes: { '/usr/bin/node': 'v22.23.2', [`${NVM}/v24.9.0/bin/node`]: 'v24.9.0' },
        });
        const resolved = await resolveAgentBins(ctx(), probes);
        expect(resolved.dsh.dir).toBe(`${NVM}/v24.9.0/bin`);
        expect(withResolvedAgentBins(BASE, resolved).dsh).toBe(true);
    });

    it('dsh on the daemon PATH with a new enough node stays as before: no extra PATH, no dshPath', async () => {
        const probes = fakeProbes({ executables: ['/usr/bin/node', '/usr/bin/dsh'], nodes: { '/usr/bin/node': 'v24.10.0' } });
        const resolved = await resolveAgentBins(ctx(), probes);
        expect(resolved.dsh).toEqual({ dir: '/usr/bin', nodeVersion: 'v24.10.0', extraPath: [] });
        const availability = withResolvedAgentBins(BASE, resolved);
        expect(availability).toMatchObject({ dsh: true, dshNode: 'v24.10.0' });
        expect(availability.dshPath).toBeUndefined();
    });

    it('only an old copy anywhere → unavailable, with the node it would run on and where it was found', async () => {
        const probes = fakeProbes({
            executables: [`${NVM}/v22.1.0/bin/node`, `${NVM}/v22.1.0/bin/dsh`],
            dirs: { [NVM]: ['v22.1.0'] },
            nodes: { [`${NVM}/v22.1.0/bin/node`]: 'v22.1.0' },
        });
        const availability = withResolvedAgentBins(BASE, await resolveAgentBins(ctx(), probes));
        expect(availability).toMatchObject({ dsh: false, dshNode: 'v22.1.0', dshPath: `${NVM}/v22.1.0/bin` });
        const refusal = spawnAgentUnavailableError('dsh', availability)!.errorMessage;
        expect(refusal).toContain(`found in ${NVM}/v22.1.0/bin`);
        expect(refusal).toContain('v22.1.0');
        expect(refusal).toContain('no daemon restart needed');
    });

    it('not installed anywhere → missing, and the refusal says where it looked and how to fix it', async () => {
        const probes = fakeProbes({ executables: ['/usr/bin/node'], nodes: { '/usr/bin/node': 'v22.23.2' } });
        const availability = withResolvedAgentBins(BASE, await resolveAgentBins(ctx(), probes));
        expect(availability.dsh).toBe(false);
        expect(availability.dshNode).toBeUndefined();
        const refusal = spawnAgentUnavailableError('dsh', availability)!.errorMessage;
        expect(refusal).toContain("the daemon's PATH, the login shell's PATH, and the Node.js install dirs of nvm, fnm, volta, mise and asdf");
        expect(refusal).toContain('npm install -g @deepseek-ai/dsh');
        expect(refusal).toContain("add that dir to your login shell's PATH");
    });

    it('a dir only on the login shell PATH counts; dsh there runs on the login shell node when none sits next to it', async () => {
        const probes = fakeProbes({
            executables: ['/usr/bin/node', '/opt/tools/bin/dsh', '/opt/node24/bin/node'],
            nodes: { '/usr/bin/node': 'v22.23.2', '/opt/node24/bin/node': 'v24.11.0' },
            loginPath: '/opt/tools/bin:/opt/node24/bin:/usr/bin:/bin',
        });
        const resolved = await resolveAgentBins(ctx(), probes);
        expect(resolved.dsh).toEqual({ dir: '/opt/tools/bin', nodeVersion: 'v24.11.0', extraPath: ['/opt/tools/bin', '/opt/node24/bin'] });
    });

    it('pi needs both pi and pi-acp; gemini alone — each from wherever it is', async () => {
        const probes = fakeProbes({
            executables: ['/usr/bin/pi', `${NVM}/v24.1.0/bin/pi-acp`, `${HOME}/.volta/bin/gemini`],
            dirs: { [NVM]: ['v24.1.0'] },
        });
        const resolved = await resolveAgentBins(ctx(), probes);
        expect(resolved.pi).toEqual([`${NVM}/v24.1.0/bin`]);
        expect(resolved.gemini).toEqual([`${HOME}/.volta/bin`]);
        expect(withResolvedAgentBins(BASE, resolved)).toMatchObject({ pi: true, gemini: true });

        const piMissing = await resolveAgentBins(ctx(), fakeProbes({ executables: ['/usr/bin/pi'] }));
        expect(piMissing.pi).toBeNull();
        expect(withResolvedAgentBins(BASE, piMissing).pi).toBe(false);
        // The PATH-only probe stays authoritative for what it already found.
        expect(withResolvedAgentBins({ ...BASE, pi: true }, piMissing).pi).toBe(true);
    });

    it('version-manager dirs: nvm / fnm / mise / asdf newest first, volta shims, env overrides honoured', async () => {
        const dirs = await versionManagerBinDirs(
            { home: HOME, env: { NVM_DIR: '/x/nvm', FNM_DIR: '/x/fnm' }, platform: 'linux' },
            { listDir: async (dir) => ({
                '/x/nvm/versions/node': ['v20.0.0', 'v24.1.0', 'v22.3.0'],
                '/x/fnm/node-versions': ['v24.2.0'],
                [`${HOME}/.local/share/mise/installs/node`]: ['24.3.0'],
                [`${HOME}/.asdf/installs/nodejs`]: ['24.4.0'],
            } as Record<string, string[]>)[dir] ?? [] },
        );
        expect(dirs).toEqual([
            '/x/nvm/versions/node/v24.1.0/bin',
            '/x/nvm/versions/node/v22.3.0/bin',
            '/x/nvm/versions/node/v20.0.0/bin',
            '/x/fnm/node-versions/v24.2.0/installation/bin',
            `${HOME}/.local/share/mise/installs/node/24.3.0/bin`,
            `${HOME}/.asdf/installs/nodejs/24.4.0/bin`,
            `${HOME}/.volta/bin`,
        ]);
    });

    it('the ACP backend (dsh, pi-acp, gemini) starts its CLI with agentChildEnv, so only the agent gets the found dir', () => {
        const backend = readFileSync(new URL('../agent/acp/AcpBackend.ts', import.meta.url), 'utf8');
        expect(backend).toContain('env: agentChildEnv({ ...process.env, ...this.options.env }),');
    });

    it('every probe is async (no execSync / existsSync / readdirSync on the daemon main thread)', () => {
        const src = readFileSync(new URL('./agentBinResolver.ts', import.meta.url), 'utf8');
        expect(src).not.toMatch(/\b(execSync|execFileSync|spawnSync|existsSync|readdirSync|accessSync|statSync)\b/);
        expect(src).toContain("from 'node:fs/promises'");
    });
});

describe('B-958: relaunches (resume / restart) carry the agent CLI dir too', () => {
    const resolvedDsh = async () => resolveAgentBins(ctx(), fakeProbes({
        executables: ['/usr/bin/node', `${NVM}/v24.22.3/bin/node`, `${NVM}/v24.22.3/bin/dsh`],
        dirs: { [NVM]: ['v24.22.3'] },
        nodes: { '/usr/bin/node': 'v22.23.2', [`${NVM}/v24.22.3/bin/node`]: 'v24.22.3' },
    }));

    it('already probed → the remembered dir, no second probe', async () => {
        rememberAgentBins(await resolvedDsh());
        let probes = 0;
        expect(await relaunchAgentPathEnv('dsh', async () => { probes++; })).toEqual({ VH_AGENT_PATH_PREPEND: `${NVM}/v24.22.3/bin` });
        expect(probes).toBe(0);
    });

    it('nothing probed yet (resume right after daemon start) → probes once, then hands the dir over', async () => {
        const resolved = await resolvedDsh();
        let probes = 0;
        const env = await relaunchAgentPathEnv('dsh', async () => { probes++; rememberAgentBins(resolved); });
        expect(probes).toBe(1);
        expect(env).toEqual({ VH_AGENT_PATH_PREPEND: `${NVM}/v24.22.3/bin` });
    });

    it('claude / codex never wait on a probe; a failing probe still spawns', async () => {
        let probes = 0;
        const recheck = async () => { probes++; };
        expect(await relaunchAgentPathEnv('claude', recheck)).toEqual({});
        expect(await relaunchAgentPathEnv('codex', recheck)).toEqual({});
        expect(probes).toBe(0);
        expect(await relaunchAgentPathEnv('pi', async () => { throw new Error('probe failed'); })).toEqual({});
        expect(await relaunchAgentPathEnv('dsh', undefined)).toEqual({});
    });
});
