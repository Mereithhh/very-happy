import { isDeepStrictEqual } from 'node:util';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TeamActionRequest, TeamResponse, TeamState, TeamOperation, TeamMessage, TeamLaunch, TeamProjectChoice } from '@slopus/happy-wire';
import { bindNewTeamProjectTx } from '@/app/projects/store';
import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { encryptString, decryptString } from '@/modules/encrypt';
import { advanceSchedules } from './schedules';
import { escalateIdleMembers } from './teamIdle';
import { otherTeamBinding, reduceTeam, requireTeam, sessionInOtherTeamMessage, teamView, transferSessionOut, TeamError, type TeamActor } from './reducer';

type Principal = { accountId: string; actor: TeamActor; credentialId?: string };
type Row = { id: string; accountId: string; version: number; projectId?: string | null; state: TeamState };
/** B-502: `VH_AGENT_TEAMS_ENABLED` is the only gate; the former `VH_AGENT_TEAMS_ACCOUNT_IDS` allowlist is ignored. */
export function assertTeamsEnabled(_accountId: string) {
    requireTeam(process.env.VH_AGENT_TEAMS_ENABLED === 'true', 'teams_disabled', 404);
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
    // B-726: `projectId` lives in its own column; it rides on the view only and is never persisted into `state`.
    row.state = { ...row.state, version: row.version, operations: ops.map(o => o.state), messages: msgs.map(m => m.state), projectId: row.projectId ?? undefined };
    return row;
}
async function persistTransition(tx: Tx, row: Row, team: TeamState): Promise<void> {
    const state = JSON.stringify({ ...team, messages: undefined, operations: undefined, projectId: undefined });
    const updated = await tx.$executeRaw`UPDATE "AgentTeam" SET "version"=${team.version},"state"=${state}::jsonb,"updatedAt"=now() WHERE "id"=${row.id} AND "accountId"=${row.accountId} AND "version"=${row.version}`;
    requireTeam(updated === 1, 'team_version_conflict');
    for (const op of team.operations) {
        if (JSON.stringify(row.state.operations.find(old => old.id === op.id)) === JSON.stringify(op)) continue;
        const encoded = JSON.stringify(op);
        await tx.$executeRaw`INSERT INTO "TeamOperation" ("id","teamId","state") VALUES (${op.id},${row.id},${encoded}::jsonb) ON CONFLICT ("id") DO UPDATE SET "state"=EXCLUDED."state"`;
    }
    for (const message of team.messages) {
        if (JSON.stringify(row.state.messages.find(old => old.id === message.id)) === JSON.stringify(message)) continue;
        const encoded = JSON.stringify(message);
        await tx.$executeRaw`INSERT INTO "TeamMessage" ("id","teamId","state") VALUES (${message.id},${row.id},${encoded}::jsonb) ON CONFLICT ("id") DO UPDATE SET "state"=EXCLUDED."state"`;
    }
    for (const old of row.state.messages) {
        if (team.messages.some(message => message.id === old.id)) continue;
        requireTeam(old.scheduleId && (old.deliveredAt !== null || old.cancelledAt !== undefined), 'unsafe_message_prune');
        const removed = await tx.$executeRaw`DELETE FROM "TeamMessage" WHERE "teamId"=${row.id} AND "id"=${old.id} AND "state"->>'scheduleId' IS NOT NULL AND ("state"->>'deliveredAt' IS NOT NULL OR "state"->>'cancelledAt' IS NOT NULL)`;
        requireTeam(removed === 1, 'message_prune_conflict');
    }
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
/**
 * B-730: a session leads or works in at most one live team. Without `transfer`
 * a bound session is refused with `session_in_other_team`; with it (the owner
 * confirmed on the Web) the old binding is released and marked transferred in
 * the same transaction. Archived teams never block.
 */
async function guardSessionTeam(tx: Tx, accountId: string, sessionId: string, targetTeamId: string, transfer: boolean): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "AgentTeam" WHERE "accountId"=${accountId} AND "id"<>${targetTeamId} AND "state"->>'archivedAt' IS NULL
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE("state"->'bots', '[]'::jsonb)) b WHERE b->>'sessionId'=${sessionId})
        ORDER BY "createdAt"`;
    for (const { id } of rows) {
        const row = await load(tx, id, accountId);
        const binding = otherTeamBinding([row.state], sessionId, targetTeamId);
        if (!binding) continue;
        if (!transfer) throw new TeamError('session_in_other_team', 409, { teamId: binding.teamId, teamName: binding.teamName, message: sessionInOtherTeamMessage(binding) });
        await persistTransition(tx, row, transferSessionOut(row.state, sessionId, targetTeamId, Date.now()));
    }
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
export async function createTeam(accountId: string, input: { name: string; machineId: string; requestId?: string; launch?: TeamLaunch; project?: TeamProjectChoice; sessionId?: string; transfer?: true }): Promise<TeamState> {
    assertTeamsEnabled(accountId);
    return inTx(async tx => {
        requireTeam(await tx.machine.findFirst({ where: { id: input.machineId, accountId }, select: { id: true } }), 'machine_not_found', 404);
        const teamId = input.requestId ? hash(`create:${accountId}:${input.requestId}`) : randomUUID();
        if (input.requestId) {
            const existing = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AgentTeam" WHERE "id"=${teamId} AND "accountId"=${accountId}`;
            if (existing[0]) {
                const existingTeam = (await load(tx, teamId, accountId)).state;
                requireTeam(existingTeam.name === input.name && existingTeam.machineId === input.machineId && isDeepStrictEqual(existingTeam.creationLaunch, input.launch), 'request_id_conflict');
                return existingTeam;
            }
        }
        // B-730: the leading session (or, from a pre-B-730 CLI, the session it inherits its project from).
        // A transfer is applied by the join that follows, so create only refuses here.
        const leadSessionId = input.sessionId ?? input.project?.inheritFromSessionId;
        if (leadSessionId && !input.transfer) await guardSessionTeam(tx, accountId, leadSessionId, teamId, false);
        const count = await tx.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM "AgentTeam" WHERE "accountId"=${accountId} AND "state"->>'archivedAt' IS NULL`;
        requireTeam(Number(count[0].count) < 32, 'team_limit', 429);
        const team: TeamState = { permissionMode: 'bypassPermissions', id: teamId, name: input.name, machineId: input.machineId, version: 0, bots: [], tasks: [], messages: [], operations: [], createdAt: Date.now(), ...(input.launch ? { creationLaunch: input.launch } : {}) };
        const state = JSON.stringify({ ...team, messages: undefined, operations: undefined });
        await tx.$executeRaw`INSERT INTO "AgentTeam" ("id","accountId","machineId","state") VALUES (${team.id},${accountId},${team.machineId},${state}::jsonb)`;
        if (input.launch) {
            const started = reduceTeam(team, { kind: 'owner' }, { type: 'start', launch: input.launch }, { now: Date.now(), id: randomUUID }).team;
            await persistTransition(tx, { id: team.id, accountId, version: 0, state: team }, started);
            if (!input.project) return started;
        }
        if (!input.project) return team;
        // B-726: same transaction, so a retried create (same requestId) returns the team already bound, never a second project.
        await bindNewTeamProjectTx(tx, accountId, team.id, input.project);
        return (await load(tx, team.id, accountId)).state;
    });
}
export async function listTeams(accountId: string, machineId?: string): Promise<TeamState[]> {
    assertTeamsEnabled(accountId);
    return inTx(async tx => {
        const rows = machineId
            ? await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AgentTeam" WHERE "accountId"=${accountId} AND "machineId"=${machineId} ORDER BY "createdAt"`
            : await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AgentTeam" WHERE "accountId"=${accountId} AND "state"->>'archivedAt' IS NULL ORDER BY "createdAt"`;
        const teams: TeamState[] = [];
        for (const row of rows) teams.push((await load(tx, row.id, accountId)).state);
        return teams.filter(team => team.archivedAt === undefined || (machineId && team.operations.some(op => ['pending', 'claimed', 'unknown', 'failed'].includes(op.status) && op.error !== 'task_closed_before_spawn')));
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
        const prior = await tx.$queryRaw<{ actorKey: string; requestHash: string; response: { credentialBotId?: string; credentialGeneration?: number; operationId?: string; taskId?: string; scheduleId?: string } }[]>`SELECT * FROM "TeamRequest" WHERE "teamId"=${teamId} AND "requestId"=${request.requestId}`;
        if (p.actor.kind === 'agent') {
            const a = p.actor;
            requireTeam(row.state.bots.some(b => b.id === a.botId && b.generation === a.generation), 'stale_agent', 403);
        }
        if (prior[0]) {
            requireTeam(prior[0].actorKey === actorKey && prior[0].requestHash === requestHash, 'request_id_conflict');
            const result: TeamResponse = { team: teamView(row.state, p.actor), taskId: prior[0].response.taskId, scheduleId: prior[0].response.scheduleId, ...(prior[0].response.scheduleId ? { scheduleRecordRetained: !!row.state.schedules?.some(s => s.id === prior[0].response.scheduleId) } : {}) };
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
        if (action.type === 'join' && p.actor.kind === 'owner' && row.state.archivedAt === undefined) await guardSessionTeam(tx, p.accountId, action.sessionId, teamId, action.transfer === true);
        const reduced = reduceTeam(row.state, p.actor, action, { now: Date.now(), id: randomUUID });
        await persistTransition(tx, row, reduced.team);
        const memo = JSON.stringify({ credentialBotId: reduced.credentialBotId, credentialGeneration: reduced.team.bots.find(b => b.id === reduced.credentialBotId)?.generation, operationId: reduced.operationId, taskId: reduced.taskId, scheduleId: reduced.scheduleId });
        await tx.$executeRaw`INSERT INTO "TeamRequest" ("teamId","requestId","actorKey","requestHash","response") VALUES (${teamId},${request.requestId},${actorKey},${requestHash},${memo}::jsonb)`;
        const response: TeamResponse = { team: teamView(reduced.team, p.actor), taskId: reduced.taskId, scheduleId: reduced.scheduleId, ...(reduced.scheduleId ? { scheduleRecordRetained: !!reduced.team.schedules?.some(s => s.id === reduced.scheduleId) } : {}) };
        if (reduced.operationId) response.operation = reduced.team.operations.find(o => o.id === reduced.operationId);
        if (reduced.credentialBotId) response.credential = await credential(tx, reduced.team, reduced.credentialBotId);
        return response;
    });
}

/** Server clock + per-team transaction: empty polls never grow the idempotency ledger. */
export async function tickTeamSchedules(accountId: string, machineId: string): Promise<{ fired: number; errors: { teamId: string; error: string }[] }> {
    assertTeamsEnabled(accountId);
    requireTeam(await db.machine.findFirst({ where: { id: machineId, accountId }, select: { id: true } }), 'machine_not_found', 404);
    const rows = await db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "AgentTeam" WHERE "accountId"=${accountId} AND "machineId"=${machineId} AND "state"->>'archivedAt' IS NULL`;
    let fired = 0;
    const errors: { teamId: string; error: string }[] = [];
    for (const { id } of rows) {
        try {
            fired += await inTx(async tx => {
                const row = await load(tx, id, accountId);
                const now = Date.now();
                const next = advanceSchedules(row.state, now);
                // B-769: the same per-machine 5 s tick (old daemons included) wakes owners of long-idle members.
                const idle = escalateIdleMembers(next.team, now, randomUUID);
                if (next.fired || idle.fired) await persistTransition(tx, row, idle.team);
                return next.fired;
            });
        } catch (error) {
            if (error instanceof Error && 'code' in error && typeof error.code === 'string') errors.push({ teamId: id, error: error.code });
            else errors.push({ teamId: id, error: 'schedule_tick_failed' });
        }
    }
    return { fired, errors };
}
