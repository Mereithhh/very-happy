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
        const flipped = Buffer.from(sig, 'base64url');
        flipped[0] ^= 0x01;
        expect(verifyMigrationHandoff(secret, `vh1.${body}.${flipped.toString('base64url')}`, now)).toBeNull();
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

    it('B-656: only the canonical signature spelling verifies (padding bits in the last char are not slack)', () => {
        const now = 1_800_000_000_000;
        // A 32-byte MAC is 43 base64url chars; the last one holds 4 data bits + 2 padding bits,
        // so it is always one of these 16 letters and has 3 non-canonical siblings.
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        for (let i = 0; i < 64; i++) {
            const token = issueMigrationHandoff(secret, { kind: 'web', accountId: `acc-${i}` }, now);
            const [, body, sig] = token.split('.');
            const last = alphabet.indexOf(sig.at(-1)!);
            expect(last & 0b11).toBe(0);
            for (let pad = 1; pad < 4; pad++) {
                const sibling = `${sig.slice(0, -1)}${alphabet[last | pad]}`;
                expect(Buffer.from(sibling, 'base64url').equals(Buffer.from(sig, 'base64url'))).toBe(true);
                expect(verifyMigrationHandoff(secret, `vh1.${body}.${sibling}`, now)).toBeNull();
            }
            expect(verifyMigrationHandoff(secret, token, now)).not.toBeNull();
        }
    });
});
