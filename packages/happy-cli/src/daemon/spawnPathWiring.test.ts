import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// B-512 wiring of the daemon spawn path (source assertions; the pure pieces —
// decideShellProbe, createSpawnTimer — have their own behavioural tests).
const run = readFileSync(join(__dirname, 'run.ts'), 'utf8');

describe('daemon spawn path (B-512)', () => {
    it('only new-session spawns accept a stale login-shell answer', () => {
        const calls = run.match(/refreshAgentHomes\((?:[^()]|\([^()]*\))*\)/g) ?? [];
        expect(calls.filter((c) => c.includes('allowStale'))).toEqual(['refreshAgentHomes(Date.now(), { allowStale: true })']);
        // daemon start + resume + restart keep the fresh contract
        expect(calls.filter((c) => c === 'refreshAgentHomes()')).toHaveLength(3);
        const spawnSession = run.slice(run.indexOf('const spawnSession = async'), run.indexOf('const spawnSessionImpl = async'));
        expect(spawnSession).toContain('await refreshAgentHomes(Date.now(), { allowStale: true });');
    });

    it('handover preflight always probes with --version (the full self-check since B-512; old bundles answer it too)', () => {
        expect(run).toContain("spawn(process.execPath, ['--no-warnings', '--no-deprecation', bundlePath, '--version'], {");
    });

    it('does not probe tmux unless a session name asks for it', () => {
        expect(run).toContain('const tmuxAvailable = tmuxSessionName !== undefined && await isTmuxAvailable();');
    });

    it('logs [SPAWN TIMING] for every new-session request', () => {
        const spawnSession = run.slice(run.indexOf('const spawnSession = async'), run.indexOf('const spawnSessionImpl = async'));
        expect(spawnSession).toContain("timer.mark('agentHome');");
        expect(spawnSession).toContain("logger.debug(timer.format({ agent: options.agent ?? 'claude', outcome: result.type }));");
        const tracked = run.slice(run.indexOf('const spawnTrackedHappyProcess = ('));
        expect(tracked.slice(0, tracked.indexOf('const trackedSession'))).toContain("timer?.mark('spawned');");
    });
});
