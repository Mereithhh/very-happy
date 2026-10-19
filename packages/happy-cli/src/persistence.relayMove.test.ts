import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const originalEnv = { ...process.env };

/** B-635: a relay move keeps the key material and swaps only token + issuer. */
describe('rewriteCredentialsForRelay', () => {
    let home: string;
    beforeEach(async () => {
        home = join(tmpdir(), `vh-relay-move-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(home, { recursive: true });
        process.env = { ...originalEnv, HAPPY_HOME_DIR: home, HAPPY_SERVER_URL: 'https://old.test' };
        vi.resetModules();
    });
    afterEach(async () => {
        process.env = { ...originalEnv };
        await rm(home, { recursive: true, force: true });
    });

    it('rewrites legacy credentials', async () => {
        const p = await import('./persistence');
        const secret = new Uint8Array(32).fill(7);
        await p.writeCredentialsLegacy({ secret, token: 'old-token' });
        const before = (await p.readCredentials())!;
        expect(before.authServerUrl).toBe('https://old.test');
        await p.rewriteCredentialsForRelay(before, { token: 'new-token', authServerUrl: 'https://api.new.test' });
        const after = (await p.readCredentials())!;
        expect(after).toMatchObject({ token: 'new-token', authServerUrl: 'https://api.new.test', encryption: { type: 'legacy' } });
        expect(after.encryption.type === 'legacy' && Buffer.from(after.encryption.secret).equals(Buffer.from(secret))).toBe(true);
        expect(JSON.parse(await readFile(join(home, 'access.key'), 'utf8'))).not.toHaveProperty('encryption');
    });

    it('rewrites data-key credentials', async () => {
        const p = await import('./persistence');
        const publicKey = new Uint8Array(32).fill(1);
        const machineKey = new Uint8Array(32).fill(2);
        await p.writeCredentialsDataKey({ publicKey, machineKey, token: 'old-token' });
        const before = (await p.readCredentials())!;
        await p.rewriteCredentialsForRelay(before, { token: 'new-token', authServerUrl: 'https://api.new.test' });
        const after = (await p.readCredentials())!;
        expect(after.token).toBe('new-token');
        expect(after.authServerUrl).toBe('https://api.new.test');
        expect(after.encryption.type).toBe('dataKey');
        if (after.encryption.type === 'dataKey') {
            expect(Buffer.from(after.encryption.publicKey).equals(Buffer.from(publicKey))).toBe(true);
            expect(Buffer.from(after.encryption.machineKey).equals(Buffer.from(machineKey))).toBe(true);
        }
    });
});
