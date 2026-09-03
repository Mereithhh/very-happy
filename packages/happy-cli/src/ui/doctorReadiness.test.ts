import { describe, expect, it } from 'vitest';
import {
    collectRuntimeReadiness,
    daemonEndpointsMatch,
    daemonReadiness,
    nodeMajor,
    nodeSupported,
    resolveClaudeCredentialReadiness,
    shareableSettingsSummary,
    tmuxSupportsSessionEnv,
    toolProbeLabel,
} from './doctorReadiness';
import { readFileSync } from 'node:fs';

describe('doctor runtime readiness', () => {
    it('reports Claude credential categories without returning secret values', () => {
        const apiKey = resolveClaudeCredentialReadiness({ ANTHROPIC_API_KEY: 'sk-ant-secret' }, () => false);
        expect(apiKey).toEqual({ configured: true, source: 'ANTHROPIC_API_KEY' });
        expect(JSON.stringify(apiKey)).not.toContain('sk-ant-secret');

        expect(resolveClaudeCredentialReadiness({ CLAUDE_CODE_USE_BEDROCK: 'true' }, () => false))
            .toEqual({ configured: true, source: 'Amazon Bedrock' });
        expect(resolveClaudeCredentialReadiness({}, path => path.endsWith('.credentials.json'), () => '', '/safe-home'))
            .toEqual({ configured: true, source: 'Claude local credentials' });
        expect(resolveClaudeCredentialReadiness(
            { CLAUDE_CONFIG_DIR: '/claude' },
            path => path.endsWith('settings.json'),
            () => JSON.stringify({ apiKeyHelper: '/secret/helper --token hidden' }),
        )).toEqual({ configured: true, source: 'Claude apiKeyHelper' });
        expect(resolveClaudeCredentialReadiness({}, () => false)).toEqual({ configured: false });
    });

    it('emits a fixed share-safe settings summary', () => {
        const summary = shareableSettingsSummary({
            schemaVersion: 2,
            onboardingCompleted: true,
            machineId: 'private-machine-id',
            apiToken: 'must-never-appear',
            todoProvider: {
                command: '/internal/bin/provider',
                args: ['--token', 'also-secret'],
                cwd: '/private/customer/repo',
            },
        });
        const serialized = JSON.stringify(summary);
        expect(summary).toMatchObject({
            schemaVersion: 2,
            onboardingCompleted: true,
            machineIdConfigured: true,
            todoProviderConfigured: true,
        });
        expect(serialized).not.toContain('must-never-appear');
        expect(serialized).not.toContain('also-secret');
        expect(serialized).not.toContain('/private/customer/repo');
        expect(serialized).not.toContain('private-machine-id');
    });

    it('parses supported Node versions without accepting junk', () => {
        expect(nodeMajor('v20.19.1')).toBe(20);
        expect(nodeMajor('22.4.0')).toBe(22);
        expect(nodeMajor('unknown')).toBeUndefined();
        expect(nodeSupported('v20.18.9')).toBe(false);
        expect(nodeSupported('v20.19.0')).toBe(true);
        expect(nodeSupported('v21.7.0')).toBe(false);
        expect(nodeSupported('v22.12.9')).toBe(false);
        expect(nodeSupported('v22.13.0')).toBe(true);
        expect(nodeSupported('v23.5.0')).toBe(false);
        expect(nodeSupported('v24.0.0')).toBe(true);
        expect(nodeSupported('unknown')).toBe(false);
    });

    it('requires a running daemon to match both configured endpoints', () => {
        expect(daemonEndpointsMatch('https://api.example/', 'https://web.example/', 'https://api.example', 'https://web.example')).toBe(true);
        expect(daemonEndpointsMatch('https://old.example', 'https://web.example', 'https://api.example', 'https://web.example')).toBe(false);
        expect(daemonEndpointsMatch(undefined, undefined, 'https://api.example', 'https://web.example')).toBe(false);
    });

    it('requires tmux 3.2 for create-time session environment flags', () => {
        expect(tmuxSupportsSessionEnv('tmux 3.1c')).toBe(false);
        expect(tmuxSupportsSessionEnv('tmux 3.2a')).toBe(true);
        expect(tmuxSupportsSessionEnv('tmux 4.0')).toBe(true);
        expect(tmuxSupportsSessionEnv('tmux master')).toBe(true);
        expect(tmuxSupportsSessionEnv(undefined)).toBe(false);
    });

    it('reports missing tools as optional capabilities, not a crash', () => {
        const versions: Record<string, { status: number; stdout: string }> = {
            tmux: { status: 0, stdout: 'tmux 3.2a\n' },
            codex: { status: 0, stdout: 'codex-cli 1.2.3\n' },
        };
        const calls: Array<[string, string[]]> = [];
        const run = ((command: string, args: string[]) => {
            calls.push([command, args]);
            const hit = versions[command];
            if (hit) return { ...hit, stderr: '', error: undefined };
            return { status: null, stdout: '', stderr: '', error: new Error('ENOENT') };
        }) as Parameters<typeof collectRuntimeReadiness>[0];

        const result = collectRuntimeReadiness(run, 'v22.19.0', () => false);
        expect(result.node.supported).toBe(true);
        expect(result.tmux.supportsSessionEnv).toBe(true);
        expect(result.agents.find(agent => agent.command === 'codex')).toMatchObject({
            available: true,
            version: 'codex-cli 1.2.3',
        });
        expect(result.agents.find(agent => agent.command === 'claude')?.available).toBe(false);
        expect(calls).toContainEqual(['tmux', ['-V']]);
        expect(calls).toContainEqual(['codex', ['--version']]);
    });

    it('checks the pi-acp adapter by PATH lookup, never by running it', () => {
        // pi-acp has no --version: running it would block on stdin serving ACP.
        const calls: string[] = [];
        const run = ((command: string) => {
            calls.push(command);
            return { status: 0, stdout: `${command} 1.0\n`, stderr: '', error: undefined };
        }) as Parameters<typeof collectRuntimeReadiness>[0];
        const looked: string[] = [];
        const result = collectRuntimeReadiness(run, 'v22.19.0', (name) => { looked.push(name); return name === 'pi-acp'; });
        expect(result.agents.find(agent => agent.command === 'pi')?.available).toBe(true);
        expect(result.piAdapter.available).toBe(true);
        expect(looked).toEqual(['pi-acp']);
        expect(calls).not.toContain('pi-acp');
    });

    it('keeps the command name next to otherwise ambiguous agent versions', () => {
        expect(toolProbeLabel({ command: 'gemini', available: true, version: '0.17.1' }))
            .toBe('gemini (0.17.1)');
        expect(toolProbeLabel({ command: 'openclaw', available: true }))
            .toBe('openclaw');
    });

    it('treats an unstarted daemon as the next first-use step before pairing', () => {
        expect(daemonReadiness(false, false, false)).toEqual({
            level: 'next',
            message: '○ Daemon not started yet — pair this machine, then run `very-happy daemon start`',
        });
        expect(daemonReadiness(true, false, false)).toMatchObject({ level: 'warning' });
        expect(daemonReadiness(true, true, true)).toMatchObject({ level: 'ready' });
    });

    it('checks the wrapper path that the published package actually ships', () => {
        const doctor = readFileSync(new URL('./doctor.ts', import.meta.url), 'utf8');
        expect(doctor).toContain("join(projectRoot, 'bin', 'very-happy.mjs')");
        expect(doctor).not.toContain("join(projectRoot, 'bin', 'happy.mjs')");
    });
});
