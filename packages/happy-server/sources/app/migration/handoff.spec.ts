import { describe, expect, it } from 'vitest';
import { issueMigrationHandoff, MIGRATION_HANDOFF_TTL_MS, signMigrationHandoff, verifyMigrationHandoff } from './handoff';

const secret = 'migration-handoff-secret-for-tests-0123456789';

describe('B-627 migration handoff signing', () => {
    it('round-trips a web and a daemon ticket and binds the machine id', () => {
        const now = 1_800_000_000_000;
        const web = verifyMigrationHandoff(secret, issueMigrationHandoff(secret, { kind: 'web', accountId: 'acc-1' }, now), now + 1000)!;
        expect(web).toMatchObject({ v: 1, kind: 'web', accountId: 'acc-1' });
        expect(web.machineId).toBeUndefined();
        expect(web.exp - web.iat).toBe(MIGRATION_HANDOFF_TTL_MS / 1000);
        const daemon = verifyMigrationHandoff(secret, issueMigrationHandoff(secret, { kind: 'daemon', accountId: 'acc-1', machineId: 'm-9' }, now), now)!;
        expect(daemon).toMatchObject({ kind: 'daemon', machineId: 'm-9' });
        expect(web.nonce).not.toBe(daemon.nonce);
    });

    it('rejects tampering, a foreign secret, expiry, future issue times and oversized lifetimes', () => {
        const now = 1_800_000_000_000;
        const token = issueMigrationHandoff(secret, { kind: 'web', accountId: 'acc-1' }, now);
        const [, body, sig] = token.split('.');
        expect(verifyMigrationHandoff('another-secret-that-is-long-enough-0123456789', token, now)).toBeNull();
        expect(verifyMigrationHandoff(secret, `vh1.${body}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, now)).toBeNull();
        const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), accountId: 'acc-2' })).toString('base64url');
        expect(verifyMigrationHandoff(secret, `vh1.${forgedBody}.${sig}`, now)).toBeNull();
        expect(verifyMigrationHandoff(secret, token, now + MIGRATION_HANDOFF_TTL_MS + 1000)).toBeNull();
        expect(verifyMigrationHandoff(secret, token, now - 120_000)).toBeNull();
        const iat = Math.floor(now / 1000);
        const long = signMigrationHandoff(secret, { v: 1, kind: 'web', accountId: 'acc-1', nonce: 'n'.repeat(32), iat, exp: iat + 24 * 3600 });
        expect(verifyMigrationHandoff(secret, long, now)).toBeNull();
        expect(verifyMigrationHandoff(secret, 'vh1.nope', now)).toBeNull();
        expect(verifyMigrationHandoff(secret, '', now)).toBeNull();
    });
});
