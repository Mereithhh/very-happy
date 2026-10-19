import { describe, expect, it, vi } from 'vitest';
import { applyServerMigration, isAcceptableRelayUrl, type ServerMigrationDeps } from './serverMigration';

const handoff = `vh1.${'a'.repeat(40)}.${'b'.repeat(43)}`;
const notice = { url: 'https://api.new.test', webappUrl: 'https://new.test', handoff, issuedAt: 1 };
const legacy = { token: 'old', authServerUrl: 'https://old.test', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };

function deps(overrides: Partial<ServerMigrationDeps> = {}) {
    const d: ServerMigrationDeps = {
        configuredServerUrl: 'https://old.test',
        env: {},
        clientId: 'cli-daemon/test',
        fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ kind: 'daemon', token: 'new-token' }) })) as unknown as typeof fetch,
        readCredentials: vi.fn(async () => legacy),
        rewriteCredentials: vi.fn(async () => {}),
        updateSettings: vi.fn(async (updater) => updater({ serverUrl: 'https://old.test', machineId: 'm' })),
        log: vi.fn(),
        ...overrides,
    };
    return d;
}

describe('B-635 follow the relay', () => {
    it('buys a token with the handoff, rewrites settings then credentials, and reports the move', async () => {
        const d = deps();
        const outcome = await applyServerMigration(notice, d);
        expect(outcome).toEqual({ action: 'moved', serverUrl: 'https://api.new.test', webappUrl: 'https://new.test' });
        expect(d.fetch).toHaveBeenCalledWith('https://api.new.test/v1/auth/migrate/complete', expect.objectContaining({ method: 'POST', body: JSON.stringify({ handoff }) }));
        const order = [...(d.updateSettings as any).mock.invocationCallOrder, ...(d.rewriteCredentials as any).mock.invocationCallOrder];
        expect(order[0]).toBeLessThan(order[1]);
        expect(await (d.updateSettings as any).mock.results[0].value).toMatchObject({ serverUrl: 'https://api.new.test', webappUrl: 'https://new.test', machineId: 'm' });
        expect(d.rewriteCredentials).toHaveBeenCalledWith(legacy, { token: 'new-token', authServerUrl: 'https://api.new.test' });
    });

    it('ignores junk and a notice for the relay it already uses', async () => {
        const d = deps();
        expect((await applyServerMigration({ url: 'x' }, d)).action).toBe('ignored');
        expect((await applyServerMigration({ ...notice, url: 'https://OLD.test/' }, d)).action).toBe('ignored');
        expect(d.fetch).not.toHaveBeenCalled();
        expect(d.updateSettings).not.toHaveBeenCalled();
    });

    it('refuses without touching disk when the environment pins the relay, the URL is not https, or the new relay says no', async () => {
        const pinned = deps({ env: { HAPPY_SERVER_URL: 'https://old.test' } });
        expect(await applyServerMigration(notice, pinned)).toMatchObject({ action: 'refused', reason: expect.stringContaining('HAPPY_SERVER_URL') });
        expect(pinned.fetch).not.toHaveBeenCalled();
        const plain = deps();
        expect((await applyServerMigration({ ...notice, url: 'http://api.new.test' }, plain)).action).toBe('refused');
        const refused = deps({ fetch: vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_handoff' }) })) as unknown as typeof fetch });
        expect(await applyServerMigration(notice, refused)).toMatchObject({ action: 'refused', reason: expect.stringContaining('401') });
        const down = deps({ fetch: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
        expect(await applyServerMigration(notice, down)).toMatchObject({ action: 'refused', reason: expect.stringContaining('ECONNREFUSED') });
        const noCreds = deps({ readCredentials: vi.fn(async () => null) });
        expect((await applyServerMigration(notice, noCreds)).action).toBe('refused');
        for (const d of [plain, refused, down, noCreds]) {
            expect(d.updateSettings).not.toHaveBeenCalled();
            expect(d.rewriteCredentials).not.toHaveBeenCalled();
        }
        expect(isAcceptableRelayUrl('http://localhost:3005')).toBe(true);
        expect(isAcceptableRelayUrl('http://10.0.0.5:3005')).toBe(false);
        expect(isAcceptableRelayUrl('not a url')).toBe(false);
    });
});
