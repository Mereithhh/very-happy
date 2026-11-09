import { describe, expect, it } from 'vitest';
import { resolveMigrationHandoffSecret, resolveMigrationSourceConfig } from './migrationConfig';

const secret = 'migration-handoff-secret-for-tests-0123456789';

describe('B-627 migration configuration', () => {
    it('is off without MIGRATION_TARGET_URL and demands a long shared secret plus a target population', () => {
        expect(resolveMigrationSourceConfig({} as NodeJS.ProcessEnv)).toBeNull();
        expect(resolveMigrationHandoffSecret({} as NodeJS.ProcessEnv)).toBeNull();
        expect(() => resolveMigrationHandoffSecret({ MIGRATION_HANDOFF_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(/32/);
        expect(() => resolveMigrationSourceConfig({ MIGRATION_TARGET_URL: 'https://vibe.example.com' } as NodeJS.ProcessEnv)).toThrow(/MIGRATION_HANDOFF_SECRET/);
        expect(() => resolveMigrationSourceConfig({ MIGRATION_TARGET_URL: 'https://vibe.example.com', MIGRATION_HANDOFF_SECRET: secret } as NodeJS.ProcessEnv)).toThrow(/who moves/);
        expect(() => resolveMigrationSourceConfig({ MIGRATION_TARGET_URL: 'http://vibe.example.com', MIGRATION_HANDOFF_SECRET: secret, MIGRATION_ACCOUNT_IDS: 'a' } as NodeJS.ProcessEnv)).toThrow(/https/);
    });

    it('normalises origins, names, ids and domains', () => {
        const config = resolveMigrationSourceConfig({
            MIGRATION_TARGET_URL: 'https://api.vibe.example.com/',
            MIGRATION_TARGET_WEBAPP_URL: 'https://vibe.example.com',
            MIGRATION_HANDOFF_SECRET: secret,
            MIGRATION_ACCOUNT_IDS: ' acc-1, acc-2 ,',
            MIGRATION_EMAIL_DOMAINS: '@Example.com, example.org',
        } as NodeJS.ProcessEnv)!;
        expect(config).toMatchObject({ targetUrl: 'https://api.vibe.example.com', targetWebappUrl: 'https://vibe.example.com', targetName: 'vibe.example.com' });
        expect([...config.accountIds]).toEqual(['acc-1', 'acc-2']);
        expect([...config.emailDomains]).toEqual(['example.com', 'example.org']);
        const named = resolveMigrationSourceConfig({ MIGRATION_TARGET_URL: 'https://vibe.example.com', MIGRATION_HANDOFF_SECRET: secret, MIGRATION_EMAIL_DOMAINS: 'example.com', MIGRATION_TARGET_NAME: ' Acme Vibe ' } as NodeJS.ProcessEnv)!;
        expect(named.targetWebappUrl).toBe('https://vibe.example.com');
        expect(named.targetName).toBe('Acme Vibe');
    });
});
