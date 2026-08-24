import { describe, expect, it } from 'vitest';
import { shareSafeEnvironmentInfo, shareSafeProcessLine } from './doctorPrivacy';

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
});
