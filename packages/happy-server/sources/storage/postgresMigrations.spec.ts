import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postgresMigrationEnvironment, runPostgresMigrations } from './postgresMigrations';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

const runtime = 'postgresql://user:password@pool/happy?connection_limit=16';
const migration = 'postgresql://user:password@pool/happy_migrations?connection_limit=1';

describe('Postgres migration connection isolation', () => {
    it('uses the session endpoint only in the spawned migration and preserves transaction limits', async () => {
        const parent = { DATABASE_URL: runtime, DATABASE_MIGRATION_URL: migration, PGOPTIONS: '-c lock_timeout=5000' };
        vi.spyOn(fs, 'existsSync').mockReturnValue(true);
        vi.mocked(spawn).mockImplementation(((_command: unknown, _args: unknown, options: any) => {
            expect(options.env.DATABASE_URL).toBe(migration);
            expect(options.env.PGOPTIONS).toBe(parent.PGOPTIONS);
            expect(options.env).not.toBe(parent);
            const child = new EventEmitter();
            queueMicrotask(() => child.emit('exit', 0, null));
            return child;
        }) as any);
        await runPostgresMigrations(parent);
        expect(spawn).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(['migrate', 'deploy']), expect.any(Object));
        expect(parent.DATABASE_URL).toBe(runtime);
    });

    it('preserves existing direct-Postgres setups when no migration URL is supplied', () => {
        const parent = { DATABASE_URL: runtime };
        expect(postgresMigrationEnvironment(parent)).toEqual(parent);
        expect(postgresMigrationEnvironment(parent)).not.toBe(parent);
    });

    it.each(['', '  ', 'not-a-url', 'https://password-secret@example.invalid'])('rejects explicit invalid configuration without echoing it', (value) => {
        expect(() => postgresMigrationEnvironment({ DATABASE_URL: runtime, DATABASE_MIGRATION_URL: value }))
            .toThrow('DATABASE_MIGRATION_URL must be a non-empty PostgreSQL URL');
    });

    it('propagates migration failure so startup cannot continue', async () => {
        vi.spyOn(fs, 'existsSync').mockReturnValue(true);
        vi.mocked(spawn).mockImplementation((() => {
            const child = new EventEmitter();
            queueMicrotask(() => child.emit('exit', 1, null));
            return child;
        }) as any);
        await expect(runPostgresMigrations({ DATABASE_URL: runtime, DATABASE_MIGRATION_URL: migration }))
            .rejects.toThrow('Prisma migrate deploy failed (exit 1)');
    });
});
