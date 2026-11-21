import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type * as Store from './store';

const DAY = 86400_000;

// B-951: capture the structured log lines, through the real sanitizer.
const logged = vi.hoisted(() => [] as Array<{ fields: Record<string, unknown>; message: string }>);
vi.mock('@/utils/log', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/log')>();
    const { sanitizeLogValue } = await import('@/utils/logSafety');
    return { ...actual, log: (fields: Record<string, unknown>, message: string) => { logged.push({ fields: sanitizeLogValue(fields) as Record<string, unknown>, message }); } };
});
const renewals = (teamId: string) => logged.filter((line) => line.message === 'team credential renewed' && line.fields.teamId === teamId);

describe('B-944 scoped team credential sliding renewal (pglite)', () => {
    const parent = join(homedir(), 'code/github/skills/tmp/agent-teams-tests');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'cred-'));
    let db: PrismaClient; let store: typeof Store; let accountId: string; let machineId: string; let n = 0;
    beforeAll(async () => {
        process.env.VH_AGENT_TEAMS_ENABLED = 'true';
        process.env.DB_PROVIDER = 'pglite'; process.env.PGLITE_DIR = join(root, 'db');
        process.env.HANDY_MASTER_SECRET = 'team-credential-test-only';
        const { runMigrations } = await import('../../standalone');
        await runMigrations({ pgliteDir: process.env.PGLITE_DIR, migrationsDir: join(process.cwd(), 'prisma/migrations') });
        ({ db } = await import('@/storage/db'));
        const { initEncrypt } = await import('@/modules/encrypt'); await initEncrypt();
        store = await import('./store');
        accountId = (await db.account.create({ data: { publicKey: crypto.randomUUID() } })).id;
        machineId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId, metadata: 'metadata' } });
    }, 60000);
    afterAll(async () => { await db?.$disconnect(); rmSync(root, { recursive: true, force: true }); });

    const lead = async () => {
        const i = ++n;
        const sessionId = (await db.session.create({ data: { accountId, tag: crypto.randomUUID(), metadata: 'metadata' } })).id;
        const team = await store.createTeam(accountId, { name: `Cred ${i}`, machineId });
        const joined = await store.actOnTeam(team.id, { accountId }, { requestId: `join-${i}`, action: { type: 'join', name: 'Lead', sessionId } });
        return { teamId: team.id, token: joined.credential!.token };
    };
    const expiry = async (teamId: string) => (await db.teamAgentCredential.findFirstOrThrow({ where: { teamId } })).expiresAt.getTime();
    const setExpiry = (teamId: string, ms: number) => db.teamAgentCredential.updateMany({ where: { teamId }, data: { expiresAt: new Date(Date.now() + ms) } });

    it('a new credential lives 30 days', async () => {
        const { teamId } = await lead();
        expect(Math.abs((await expiry(teamId)) - Date.now() - 30 * DAY)).toBeLessThan(60_000);
    });
    it('8 days left: a successful request does not renew', async () => {
        const { teamId, token } = await lead();
        await setExpiry(teamId, 8 * DAY);
        const before = await expiry(teamId);
        await store.readTeam(teamId, { token });
        expect(await expiry(teamId)).toBe(before);
    });
    it('6 days left: the first request renews to 30 days, the second the same day writes nothing', async () => {
        const { teamId, token } = await lead();
        await setExpiry(teamId, 6 * DAY);
        await store.readTeam(teamId, { token });
        const renewed = await expiry(teamId);
        expect(Math.abs(renewed - Date.now() - 30 * DAY)).toBeLessThan(60_000);
        // B-951: one readable line once committed — who, which generation, from when to when; no token.
        const [line, ...more] = renewals(teamId);
        expect(more).toHaveLength(0);
        expect(line.fields).toMatchObject({ module: 'teams', teamId, botId: expect.stringMatching(/^[A-Za-z0-9_-]+$/), generation: expect.any(Number), expiresAt: new Date(renewed).toISOString(), previousExpiresAt: expect.stringMatching(/Z$/) });
        expect(JSON.stringify(line)).not.toContain(token);
        await store.readTeam(teamId, { token });
        await store.actOnTeam(teamId, { token }, { requestId: `noop-${n}`, action: { type: 'message', body: 'hi' } as never }).catch(() => undefined);
        expect(await expiry(teamId)).toBe(renewed);
    });
    it('a revoked credential is not renewed and stays 401', async () => {
        const { teamId, token } = await lead();
        await setExpiry(teamId, 6 * DAY);
        const before = await expiry(teamId);
        await db.teamAgentCredential.updateMany({ where: { teamId }, data: { revokedAt: new Date() } });
        await expect(store.readTeam(teamId, { token })).rejects.toMatchObject({ code: 'invalid_team_token', status: 401 });
        expect(await expiry(teamId)).toBe(before);
    });
    it('an expired credential stays 401 and is not revived', async () => {
        const { teamId, token } = await lead();
        await setExpiry(teamId, -1000);
        const before = await expiry(teamId);
        await expect(store.readTeam(teamId, { token })).rejects.toMatchObject({ code: 'invalid_team_token' });
        expect(await expiry(teamId)).toBe(before);
    });
    it('a request that fails after the token resolved rolls the renewal back', async () => {
        const { teamId, token } = await lead();
        await setExpiry(teamId, 6 * DAY);
        const before = await expiry(teamId);
        await expect(store.actOnTeam(teamId, { token }, { requestId: `forge-${n}`, action: { type: 'join', name: 'evil', sessionId: 'nope' } })).rejects.toBeTruthy();
        expect(await expiry(teamId)).toBe(before);
        // B-951: the rolled-back renewal leaves no "renewed" line.
        expect(renewals(teamId)).toHaveLength(0);
    });
    it('health counts expiring and expired root credentials of active sessions only', async () => {
        const { rootTeamCredentialHealth } = await import('./credentials');
        const a = await lead(); const b = await lead();
        await setExpiry(a.teamId, 3 * DAY); await setExpiry(b.teamId, -DAY);
        const health = await rootTeamCredentialHealth(db as never);
        expect(health.expiring).toBeGreaterThanOrEqual(1);
        expect(health.expired).toBeGreaterThanOrEqual(1);
    });
});
