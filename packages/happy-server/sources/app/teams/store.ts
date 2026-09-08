import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TeamActionRequest, TeamResponse, TeamState, TeamOperation, TeamMessage } from '@slopus/happy-wire';
import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { encryptString, decryptString } from '@/modules/encrypt';
import { reduceTeam, requireTeam, teamView, type TeamActor } from './reducer';

type Principal = { accountId: string; actor: TeamActor; credentialId?: string };
type Row = { id: string; accountId: string; version: number; state: TeamState };
export function assertTeamsEnabled(accountId: string) {
    requireTeam(process.env.VH_AGENT_TEAMS_ENABLED === 'true', 'teams_disabled', 404);
    const allowlist = process.env.VH_AGENT_TEAMS_ACCOUNT_IDS?.split(',').map(s => s.trim()).filter(Boolean);
    requireTeam(!allowlist?.length || allowlist.includes(accountId), 'teams_disabled', 404);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const path = (teamId: string, botId: string) => ['teams', teamId, botId, 'credential'];

async function load(tx: Tx, teamId: string, accountId?: string): Promise<Row> {
    const rows = accountId
        ? await tx.$queryRaw<Row[]>`SELECT * FROM "AgentTeam" WHERE "id"=${teamId} AND "accountId"=${accountId}`
        : await tx.$queryRaw<Row[]>`SELECT * FROM "AgentTeam" WHERE "id"=${teamId}`;
    requireTeam(rows[0], 'team_not_found', 404);
    const row = rows[0];
    const ops = await tx.$queryRaw<{ state: TeamOperation }[]>`SELECT "state" FROM "TeamOperation" WHERE "teamId"=${teamId} ORDER BY "createdAt", "id"`;
    const msgs = await tx.$queryRaw<{ state: TeamMessage }[]>`SELECT "state" FROM "TeamMessage" WHERE "teamId"=${teamId} ORDER BY "createdAt", "id"`;
    row.state = { ...row.state, version: row.version, operations: ops.map(o => o.state), messages: msgs.map(m => m.state) };
    return row;
}
async function principal(tx: Tx, teamId: string, auth: { accountId: string } | { token: string }): Promise<Principal> {
    if ('accountId' in auth) { assertTeamsEnabled(auth.accountId); return { accountId: auth.accountId, actor: { kind: 'owner' } }; }
    requireTeam(auth.token.startsWith('vh_team_'), 'invalid_team_token', 401);
    const tokenHash = hash(auth.token);
    const rows = await tx.$queryRaw<{ id: string; accountId: string; botId: string; generation: number }[]>`
        SELECT c."id", t."accountId", c."botId", c."generation" FROM "TeamAgentCredential" c
        JOIN "AgentTeam" t ON t."id"=c."teamId"
        WHERE c."teamId"=${teamId} AND c."tokenHash"=${tokenHash} AND c."revokedAt" IS NULL AND c."expiresAt">now()`;
    requireTeam(rows[0], 'invalid_team_token', 401);
    assertTeamsEnabled(rows[0].accountId);
    return { accountId: rows[0].accountId, actor: { kind: 'agent', botId: rows[0].botId, generation: rows[0].generation }, credentialId: rows[0].id };
}
async function credential(tx: Tx, team: TeamState, botId: string): Promise<{ botId: string; token: string }> {
    const bot = team.bots.find(b => b.id === botId)!;
    const prior = await tx.$queryRaw<{ tokenEnc: string }[]>`SELECT "tokenEnc" FROM "TeamAgentCredential" WHERE "teamId"=${team.id} AND "botId"=${botId} AND "generation"=${bot.generation} AND "revokedAt" IS NULL AND "expiresAt">now() LIMIT 1`;
    if (prior[0]) return { botId, token: decryptString(path(team.id, botId), Buffer.from(prior[0].tokenEnc, 'base64')) };
    await tx.$executeRaw`UPDATE "TeamAgentCredential" SET "revokedAt"=now() WHERE "teamId"=${team.id} AND "botId"=${botId} AND "revokedAt" IS NULL`;
    const token = `vh_team_${randomBytes(32).toString('base64url')}`;
    const tokenHash = hash(token);
    const tokenEnc = Buffer.from(encryptString(path(team.id, botId), token)).toString('base64');
    const credentialId = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 86400_000);
    await tx.$executeRaw`INSERT INTO "TeamAgentCredential" ("id","teamId","botId","generation","tokenHash","tokenEnc","expiresAt") VALUES (${credentialId},${team.id},${botId},${bot.generation},${tokenHash},${tokenEnc},${expiresAt})`;
    return { botId, token };
}
export async function createTeam(accountId: string, input: { name: string; machineId: string; requestId?: string }): Promise<TeamState> {
    assertTeamsEnabled(accountId);
    return inTx(async tx => {
        requireTeam(await tx.machine.findFirst({ where: { id: input.machineId, accountId }, select: { id: true } }), 'machine_not_found', 404);
        const teamId = input.requestId ? hash(`create:${accountId}:${input.requestId}`) : randomUUID();
        if (input.requestId) {
            const existing = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AgentTeam" WHERE "id"=${teamId} AND "accountId"=${accountId}`;
            if (existing[0]) {
                const existingTeam = (await load(tx, teamId, accountId)).state;
                requireTeam(existingTeam.name === input.name && existingTeam.machineId === input.machineId, 'request_id_conflict');
                return existingTeam;
            }
        }
        const count = await tx.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM "AgentTeam" WHERE "accountId"=${accountId}`;
        requireTeam(Number(count[0].count) < 32, 'team_limit', 429);
        const team: TeamState = { id: teamId, name: input.name, machineId: input.machineId, version: 0, bots: [], tasks: [], messages: [], operations: [], createdAt: Date.now() };
        const state = JSON.stringify({ ...team, messages: undefined, operations: undefined });
        await tx.$executeRaw`INSERT INTO "AgentTeam" ("id","accountId","machineId","state") VALUES (${team.id},${accountId},${team.machineId},${state}::jsonb)`;
        return team;
    });
}
export async function listTeams(accountId: string, machineId?: string): Promise<TeamState[]> {
    assertTeamsEnabled(accountId);
    return inTx(async tx => {
        const rows = machineId
            ? await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AgentTeam" WHERE "accountId"=${accountId} AND "machineId"=${machineId} ORDER BY "createdAt"`
            : await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AgentTeam" WHERE "accountId"=${accountId} ORDER BY "createdAt"`;
        const teams: TeamState[] = [];
        for (const row of rows) teams.push((await load(tx, row.id, accountId)).state);
        return teams;
    });
}
export async function readTeam(teamId: string, auth: { accountId: string } | { token: string }): Promise<TeamState> {
    return inTx(async tx => {
        const p = await principal(tx, teamId, auth);
        const { state } = await load(tx, teamId, p.accountId);
        if (p.actor.kind === 'agent') { const a = p.actor; requireTeam(state.bots.some(b => b.id === a.botId && b.generation === a.generation), 'stale_agent', 403); }
        return teamView(state, p.actor);
    });
}
export async function actOnTeam(teamId: string, auth: { accountId: string } | { token: string }, request: TeamActionRequest): Promise<TeamResponse> {
    return inTx(async tx => {
        const p = await principal(tx, teamId, auth);
        const row = await load(tx, teamId, p.accountId);
        const actorKey = p.actor.kind === 'owner' ? `owner:${p.accountId}` : `agent:${p.actor.botId}:${p.actor.generation}`;
        const requestHash = hash(JSON.stringify(request.action));
        const prior = await tx.$queryRaw<{ actorKey: string; requestHash: string; response: { credentialBotId?: string; credentialGeneration?: number; operationId?: string } }[]>`SELECT * FROM "TeamRequest" WHERE "teamId"=${teamId} AND "requestId"=${request.requestId}`;
        if (p.actor.kind === 'agent') {
            const a = p.actor;
            requireTeam(row.state.bots.some(b => b.id === a.botId && b.generation === a.generation), 'stale_agent', 403);
        }
        if (prior[0]) {
            requireTeam(prior[0].actorKey === actorKey && prior[0].requestHash === requestHash, 'request_id_conflict');
            const result: TeamResponse = { team: teamView(row.state, p.actor) };
            if (prior[0].response.operationId) result.operation = row.state.operations.find(o => o.id === prior[0].response.operationId);
            if (prior[0].response.credentialBotId) {
                requireTeam(row.state.bots.find(b => b.id === prior[0].response.credentialBotId)?.generation === prior[0].response.credentialGeneration, 'stale_credential_request');
                result.credential = await credential(tx, row.state, prior[0].response.credentialBotId);
            }
            return result;
        }
        const action = request.action;
        if (action.type === 'join' || (action.type === 'complete-operation' && action.sessionId)) {
            const sessionId = action.sessionId!;
            requireTeam(await tx.session.findFirst({ where: { id: sessionId, accountId: p.accountId }, select: { id: true } }), 'session_not_found', 404);
        }
        if (action.type === 'join' && action.botId) {
            const old = row.state.bots.find(b => b.id === action.botId);
            if (old?.sessionId && old.sessionId !== action.sessionId) {
                const oldSession = await tx.session.findFirst({ where: { id: old.sessionId, accountId: p.accountId }, select: { active: true } });
                requireTeam(!oldSession?.active, 'old_session_still_active');
            }
        }
        const reduced = reduceTeam(row.state, p.actor, action, { now: Date.now(), id: randomUUID });
        const state = JSON.stringify({ ...reduced.team, messages: undefined, operations: undefined });
        const updated = await tx.$executeRaw`UPDATE "AgentTeam" SET "version"=${reduced.team.version},"state"=${state}::jsonb,"updatedAt"=now() WHERE "id"=${teamId} AND "accountId"=${p.accountId} AND "version"=${row.version}`;
        requireTeam(updated === 1, 'team_version_conflict');
        for (const op of reduced.team.operations) {
            const encoded = JSON.stringify(op);
            await tx.$executeRaw`INSERT INTO "TeamOperation" ("id","teamId","state") VALUES (${op.id},${teamId},${encoded}::jsonb) ON CONFLICT ("id") DO UPDATE SET "state"=EXCLUDED."state"`;
        }
        for (const msg of reduced.team.messages) {
            const encoded = JSON.stringify(msg);
            await tx.$executeRaw`INSERT INTO "TeamMessage" ("id","teamId","state") VALUES (${msg.id},${teamId},${encoded}::jsonb) ON CONFLICT ("id") DO UPDATE SET "state"=EXCLUDED."state"`;
        }
        const memo = JSON.stringify({ credentialBotId: reduced.credentialBotId, credentialGeneration: reduced.team.bots.find(b => b.id === reduced.credentialBotId)?.generation, operationId: reduced.operationId });
        await tx.$executeRaw`INSERT INTO "TeamRequest" ("teamId","requestId","actorKey","requestHash","response") VALUES (${teamId},${request.requestId},${actorKey},${requestHash},${memo}::jsonb)`;
        const response: TeamResponse = { team: teamView(reduced.team, p.actor) };
        if (reduced.operationId) response.operation = reduced.team.operations.find(o => o.id === reduced.operationId);
        if (reduced.credentialBotId) response.credential = await credential(tx, reduced.team, reduced.credentialBotId);
        return response;
    });
}
