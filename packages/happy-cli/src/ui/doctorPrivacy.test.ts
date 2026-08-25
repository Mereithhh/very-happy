import { describe, expect, it } from 'vitest';
import { shareSafeDaemonState, shareSafeEnvironmentInfo, shareSafeProcessLine } from './doctorPrivacy';

describe('doctor privacy', () => {
    it('never includes arbitrary process arguments in diagnostics', () => {
        const line = shareSafeProcessLine({
            pid: 4242,
            command: 'very-happy acp -- provider --token super-secret --prompt private-work',
        });

        expect(line).toBe('PID 4242: command arguments hidden for privacy');
        expect(line).not.toContain('super-secret');
        expect(line).not.toContain('private-work');
    });

    it('reduces environment diagnostics to flags and runtime categories', () => {
        const info = shareSafeEnvironmentInfo({
            HAPPY_HOME_DIR: '/Users/private-person/.very-happy',
            HAPPY_SERVER_URL: 'https://token:super-secret@relay.example.com',
            HAPPY_PROJECT_ROOT: '/private/client-project',
            DEBUG: 'private-debug-namespace',
            NODE_ENV: 'secret-custom-environment',
            USER: 'private-person',
            HOME: '/Users/private-person',
        }, {
            pid: 4242,
            version: 'v22.19.0',
            platform: 'darwin',
            arch: 'arm64',
        });

        expect(info).toMatchObject({
            happyHomeDirConfigured: true,
            customServerUrlConfigured: true,
            projectRootConfigured: true,
            debugEnabled: true,
            nodeEnvironment: 'custom',
            platform: 'darwin',
            arch: 'arm64',
        });
        const serialized = JSON.stringify(info);
        for (const privateValue of ['private-person', 'super-secret', 'client-project', 'private-debug-namespace', 'secret-custom-environment']) {
            expect(serialized).not.toContain(privateValue);
        }
        expect(info).not.toHaveProperty('processArgv');
    });

    it('never includes the daemon control bearer token in shareable status', () => {
        const summary = shareSafeDaemonState({
            pid: 42,
            httpPort: 31337,
            controlToken: 'must-never-appear-in-doctor-output',
            startTime: 'now',
            startedWithCliVersion: '0.2.66',
            serverUrl: 'https://veryhappy.dev',
        });

        expect(summary).toMatchObject({
            pid: 42,
            httpPort: 31337,
            controlAuthentication: 'configured',
        });
        expect(summary).not.toHaveProperty('controlToken');
        expect(JSON.stringify(summary)).not.toContain('must-never-appear');
        expect(shareSafeDaemonState({
            pid: 1,
            httpPort: 2,
            startTime: 'then',
            startedWithCliVersion: '0.2.64',
        }).controlAuthentication).toBe('legacy');
    });
});
