import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
    PROJECT_LIMITS,
    type ProjectCreate, type ProjectUpdate, type ProjectInstructionsPut, type ProjectMembersAdd, type ProjectLogCreate, type ProjectPresencePut,
    type ProjectMessageCreate, type ProjectView, type ProjectMemberView, type ProjectLogEntryView, type ProjectPresenceView, type ProjectMessageView,
    type ProjectDetailResponse, type ProjectListResponse, type TeamProjectChoice, resolveTeamWorktreePath, type TeamProjectBind, type ProjectSessionContext, type ProjectDigest, type ProjectInstructionsRevisionView, type ProjectLogKind,
} from '@slopus/happy-wire';
import { inTx, isRetryableTransactionConflict, type Tx } from '@/storage/inTx';
import { configuredResourceLimit, enforceAccountWriteRate, isAccountResourceLimitError } from '@/app/api/resourceLimits';
import {
    ProjectError, requireProject, normalizeFolders, normalizeDefaults, readFolders, readDefaults, noteQuotaRefusal, parseLogRef,
    teamMachineAllowed, snapshotTeamDefaults,
} from './rules';

/**
 * B-644 Projects store (`specs/2026-10-projects.md` §2). Every mutation runs
 * in a SERIALIZABLE `inTx` (retries P2034 and P2010+40001/40P01, AGENTS rule
 * 12); exhausted retries surface as a retryable 409 `transaction_conflict`.
 *
 * Membership = explicit `ProjectMember` rows ∪ the current bot sessions of
 * teams attached to the project (derived at read time, never double-written).
 * An explicit row wins over a team-derived one.
 */

type ProjectRow = Prisma.ProjectGetPayload<{}>;
type LogRow = Prisma.ProjectLogEntryGetPayload<{}>;
type PresenceRow = Prisma.ProjectPresenceGetPayload<{}>;
type MessageRow = Prisma.ProjectMessageGetPayload<{}>;
type Membership = { projectId: string; via: string; teamId?: string; teamName?: string; teamLead?: boolean };

const DEFAULT_MAX_PROJECTS_PER_ACCOUNT = 200;
const MAX_UNDELIVERED_PER_RECIPIENT = 100;
const CONTEXT_DECISIONS = 8;
const CONTEXT_SESSIONS = 8;
const CONTEXT_UNREAD = 3;

/** Default on; `VH_PROJECTS_ENABLED=false` is the kill switch (clients then see the same 404 as an older server). */
export function assertProjectsEnabled() {
    requireProject(process.env.VH_PROJECTS_ENABLED !== 'false', 'projects_disabled', 404);
}

const ms = (d: Date | null | undefined) => d ? d.getTime() : null;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function mapError(error: unknown): never {
    if (isRetryableTransactionConflict(error)) throw new ProjectError('transaction_conflict', 409);
    if (isAccountResourceLimitError(error)) throw new ProjectError(error.code, error.statusCode);
    throw error;
}
async function run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    assertProjectsEnabled();
    try { return await inTx(fn); } catch (error) { return mapError(error); }
}

function projectView(row: ProjectRow, teamIds: string[] = [], automationIds: string[] = []): ProjectView {
    return {
        id: row.id, name: row.name, goal: row.goal, instructions: row.instructions, instructionsVersion: row.instructionsVersion,
        instructionsUpdatedBy: row.instructionsUpdatedBy, instructionsUpdatedAt: ms(row.instructionsUpdatedAt),
        folders: readFolders(row.folders), defaults: readDefaults(row.defaults), archivedAt: ms(row.archivedAt),
        createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime(), teamIds, automationIds,
    };
}
/** Superseded-by is derived: the newest live entry naming this one in `supersedes`. */
function logView(row: LogRow, supersededBy: string | null = null): ProjectLogEntryView {
    return {
        id: row.id, seq: row.seq, projectId: row.projectId, kind: row.kind as ProjectLogKind, title: row.title, body: row.body,
        authorSessionId: row.authorSessionId, authorUser: row.authorUser, supersedes: row.supersedes, supersededBy,
        revokedAt: ms(row.revokedAt), createdAt: row.createdAt.getTime(),
    };
}
function logViews(rows: LogRow[]): ProjectLogEntryView[] {
    const by = new Map<string, string>();
    for (const r of rows) if (r.supersedes && !r.revokedAt) by.set(r.supersedes, r.id);
    return rows.map(r => logView(r, by.get(r.id) ?? null));
}
function presenceView(row: PresenceRow): ProjectPresenceView {
    return {
        sessionId: row.sessionId, projectId: row.projectId, machineId: row.machineId, title: row.title, agent: row.agent, machine: row.machine,
        branch: row.branch, state: row.state, doing: row.doing, injectedInstructionsVersion: row.injectedInstructionsVersion,
        capabilities: Array.isArray(row.capabilities) ? row.capabilities.filter((c): c is string => typeof c === 'string') : [],
        updatedAt: row.updatedAt.getTime(),
    };
}
function messageView(row: MessageRow): ProjectMessageView {
    return { id: row.id, projectId: row.projectId, fromSessionId: row.fromSessionId, toSessionId: row.toSessionId, body: row.body, deliveredAt: ms(row.deliveredAt), createdAt: row.createdAt.getTime() };
}

async function loadProject(tx: Tx, accountId: string, id: string): Promise<ProjectRow> {
    const row = await tx.project.findFirst({ where: { id, accountId } });
    requireProject(row, 'project_not_found', 404);
    return row;
}
async function attachedIds(tx: Tx, projectIds: string[]): Promise<{ teams: Map<string, string[]>; automations: Map<string, string[]> }> {
    const teams = new Map<string, string[]>();
    const automations = new Map<string, string[]>();
    if (projectIds.length === 0) return { teams, automations };
    for (const t of await tx.agentTeam.findMany({ where: { projectId: { in: projectIds } }, select: { id: true, projectId: true } })) {
        teams.set(t.projectId!, [...(teams.get(t.projectId!) ?? []), t.id]);
    }
    for (const a of await tx.automation.findMany({ where: { projectId: { in: projectIds } }, select: { id: true, projectId: true } })) {
        automations.set(a.projectId!, [...(automations.get(a.projectId!) ?? []), a.id]);
    }
    return { teams, automations };
}

/** Current bot sessions of the given attached teams; archived teams contribute nobody. */
async function teamDerivedMembers(tx: Tx, accountId: string, projectIds: string[]): Promise<ProjectMemberView[]> {
    if (projectIds.length === 0) return [];
    const rows = await tx.agentTeam.findMany({ where: { accountId, projectId: { in: projectIds } }, select: { id: true, projectId: true, state: true, createdAt: true } });
    const out: ProjectMemberView[] = [];
    for (const row of rows) {
        const state = row.state as { archivedAt?: number; bots?: { sessionId?: string | null }[] } | null;
        if (!state || state.archivedAt) continue;
        for (const bot of state.bots ?? []) {
            if (typeof bot.sessionId === 'string' && bot.sessionId) {
                out.push({ projectId: row.projectId!, sessionId: bot.sessionId, via: 'team', machineId: null, teamId: row.id, createdAt: row.createdAt.getTime() });
            }
        }
    }
    return out;
}
/** Explicit ∪ team-derived, explicit wins and a session appears once. */
async function membersOf(tx: Tx, accountId: string, projectIds: string[]): Promise<ProjectMemberView[]> {
    if (projectIds.length === 0) return [];
    const explicitRows = await tx.projectMember.findMany({ where: { accountId, projectId: { in: projectIds } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const explicit: ProjectMemberView[] = explicitRows.map(m => ({ projectId: m.projectId, sessionId: m.sessionId, via: m.via, machineId: m.machineId, createdAt: m.createdAt.getTime() }));
    const taken = new Set(explicit.map(m => m.sessionId));
    // A session explicitly placed in ANY project is not re-derived into another one.
    const derived = await teamDerivedMembers(tx, accountId, projectIds);
    const derivedIds = derived.map(d => d.sessionId).filter(id => !taken.has(id));
    if (derivedIds.length) {
        for (const m of await tx.projectMember.findMany({ where: { sessionId: { in: derivedIds } }, select: { sessionId: true } })) taken.add(m.sessionId);
    }
    const out = [...explicit];
    for (const d of derived) { if (!taken.has(d.sessionId)) { taken.add(d.sessionId); out.push(d); } }
    return out;
}
async function membershipOf(tx: Tx, accountId: string, sessionId: string): Promise<Membership | null> {
    const explicit = await tx.projectMember.findFirst({ where: { sessionId, accountId }, select: { projectId: true, via: true } });
    if (explicit) return { projectId: explicit.projectId, via: explicit.via };
    const teams = await tx.$queryRaw<{ id: string; projectId: string; name: string | null; lead: boolean | null }[]>`
        SELECT t."id", t."projectId", t."state"->>'name' AS "name",
          EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(t."state"->'bots', '[]'::jsonb)) r WHERE r->>'sessionId' = ${sessionId} AND r->>'root' = 'true') AS "lead"
        FROM "AgentTeam" t
        WHERE t."accountId"=${accountId} AND t."projectId" IS NOT NULL AND (t."state"->'archivedAt') IS NULL
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(t."state"->'bots', '[]'::jsonb)) b WHERE b->>'sessionId' = ${sessionId})
        ORDER BY t."createdAt" ASC LIMIT 1`;
    return teams[0] ? { projectId: teams[0].projectId, via: 'team', teamId: teams[0].id, teamName: teams[0].name ?? teams[0].id, teamLead: teams[0].lead === true } : null;
}
async function requireMember(tx: Tx, accountId: string, projectId: string, sessionId: string): Promise<Membership> {
    const m = await membershipOf(tx, accountId, sessionId);
    // 409, never 401/403: Web clients treat 401/403 as "signed out" (authLatch).
    requireProject(m && m.projectId === projectId, 'not_a_project_member', 409);
    return m;
}
/** Only this account's own sessions may join (a session shared TO me is someone else's row). Unknown and foreign look the same. */
async function requireOwnSessions(tx: Tx, accountId: string, sessionIds: string[]): Promise<void> {
    const unique = [...new Set(sessionIds)];
    const owned = await tx.session.findMany({ where: { id: { in: unique }, accountId }, select: { id: true } });
    if (owned.length !== unique.length) {
        const have = new Set(owned.map(s => s.id));
        throw new ProjectError('session_not_found', 404, { sessionIds: unique.filter(id => !have.has(id)) });
    }
}
async function requireFolderMachines(tx: Tx, accountId: string, folders: { machineId: string }[]): Promise<void> {
    const ids = [...new Set(folders.map(f => f.machineId))];
    if (ids.length === 0) return;
    const found = await tx.machine.findMany({ where: { accountId, id: { in: ids } }, select: { id: true } });
    requireProject(found.length === ids.length, 'invalid_folders', 400, { reason: 'machine_not_found' });
}
/** Move semantics: a session leaving project A for B drops its A presence and read cursor. */
async function placeMembers(tx: Tx, accountId: string, projectId: string, sessionIds: string[], via: string): Promise<void> {
    const unique = [...new Set(sessionIds)];
    await requireOwnSessions(tx, accountId, unique);
    for (const sessionId of unique) {
        await tx.projectMember.upsert({
            where: { sessionId },
            create: { id: randomUUID(), projectId, sessionId, accountId, via },
            update: { projectId, via },
        });
    }
    await tx.projectPresence.deleteMany({ where: { sessionId: { in: unique }, projectId: { not: projectId } } });
    await tx.projectReadCursor.deleteMany({ where: { sessionId: { in: unique }, projectId: { not: projectId } } });
}

// ─── Projects ─────────────────────────────────────────────────────────────

/** Lists projects with every member mapping so the sidebar can group in one request. */
export async function listProjects(accountId: string, opts: { includeArchived?: boolean } = {}): Promise<ProjectListResponse> {
    return run(async tx => {
        const rows = await tx.project.findMany({ where: { accountId, ...(opts.includeArchived ? {} : { archivedAt: null }) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
        const ids = rows.map(r => r.id);
        const attached = await attachedIds(tx, ids);
        return {
            projects: rows.map(r => projectView(r, attached.teams.get(r.id) ?? [], attached.automations.get(r.id) ?? [])),
            members: await membersOf(tx, accountId, ids),
        };
    });
}

/** Idempotent by `requestId`; counted against the per-account cap inside the same transaction. */
export async function createProject(accountId: string, input: ProjectCreate): Promise<ProjectView> {
    return run(async tx => {
        const { row, created } = await createProjectTx(tx, accountId, input);
        if (!created) {
            const attached = await attachedIds(tx, [row.id]);
            return projectView(row, attached.teams.get(row.id) ?? [], attached.automations.get(row.id) ?? []);
        }
        return projectView(row);
    });
}

/** Transaction-level create (B-726 also uses it when a team is created). `created=false` = the requestId's earlier project. */
async function createProjectTx(tx: Tx, accountId: string, input: ProjectCreate): Promise<{ row: ProjectRow; created: boolean }> {
    const requestKey = input.requestId ? hash(`project:${accountId}:${input.requestId}`) : null;
    if (requestKey) {
        const prior = await tx.project.findFirst({ where: { requestKey, accountId } });
        if (prior) return { row: prior, created: false };
    }
    const limit = configuredResourceLimit('MAX_PROJECTS_PER_ACCOUNT', DEFAULT_MAX_PROJECTS_PER_ACCOUNT);
    if (limit > 0) {
        const count = await tx.project.count({ where: { accountId, archivedAt: null } });
        requireProject(count < limit, 'project_count_quota_exceeded', 429, { limit, count });
    }
    const folders = normalizeFolders(input.folders ?? []);
    await requireFolderMachines(tx, accountId, folders);
    const now = new Date();
    const instructions = input.instructions ?? '';
    const row = await tx.project.create({ data: {
        id: randomUUID(), accountId, name: input.name, goal: input.goal ?? null, instructions,
        instructionsVersion: instructions ? 1 : 0, instructionsUpdatedBy: instructions ? 'user' : null, instructionsUpdatedAt: instructions ? now : null,
        folders, defaults: normalizeDefaults(input.defaults), requestKey, createdAt: now, updatedAt: now,
    } });
    if (instructions) await tx.projectInstructionsRevision.create({ data: { projectId: row.id, version: 1, instructions, updatedBy: 'user', createdAt: now } });
    if (input.sessionIds?.length) await placeMembers(tx, accountId, row.id, input.sessionIds, 'explicit');
    return { row, created: true };
}

export async function getProject(accountId: string, id: string): Promise<ProjectDetailResponse> {
    return run(async tx => {
        const row = await loadProject(tx, accountId, id);
        const attached = await attachedIds(tx, [id]);
        // Sequential on purpose: PGlite's interactive transaction is a single connection.
        const members = await membersOf(tx, accountId, [id]);
        const presence = await tx.projectPresence.findMany({ where: { projectId: id, accountId }, orderBy: { updatedAt: 'desc' } });
        const log = await tx.projectLogEntry.findMany({ where: { projectId: id }, orderBy: { seq: 'asc' } });
        return { project: projectView(row, attached.teams.get(id) ?? [], attached.automations.get(id) ?? []), members, presence: presence.map(presenceView), log: logViews(log) };
    });
}

export async function updateProject(accountId: string, id: string, input: ProjectUpdate): Promise<ProjectView> {
    return run(async tx => {
        await loadProject(tx, accountId, id);
        const folders = input.folders ? normalizeFolders(input.folders) : undefined;
        if (folders) await requireFolderMachines(tx, accountId, folders);
        const row = await tx.project.update({ where: { id }, data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.goal !== undefined ? { goal: input.goal } : {}),
            ...(folders ? { folders } : {}),
            ...(input.defaults !== undefined ? { defaults: normalizeDefaults(input.defaults) } : {}),
            ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
            updatedAt: new Date(),
        } });
        const attached = await attachedIds(tx, [id]);
        return projectView(row, attached.teams.get(id) ?? [], attached.automations.get(id) ?? []);
    });
}

/** Deletes the project and everything it owns; teams/automations are detached (FK SET NULL), sessions are untouched. */
export async function deleteProject(accountId: string, id: string): Promise<void> {
    await run(async tx => {
        await loadProject(tx, accountId, id);
        await tx.projectReadCursor.deleteMany({ where: { projectId: id } });
        await tx.project.delete({ where: { id } });
    });
}

/**
 * Instructions are human-only and CAS-written: `ifVersion` must match the
 * stored version, otherwise 409 `instructions_version_conflict` carrying the
 * latest project so the editor can rebase. Every version is kept.
 */
export async function putInstructions(accountId: string, id: string, input: ProjectInstructionsPut, updatedBy = 'user'): Promise<ProjectView> {
    return run(async tx => {
        const row = await loadProject(tx, accountId, id);
        if (row.instructionsVersion !== input.ifVersion) {
            const attached = await attachedIds(tx, [id]);
            throw new ProjectError('instructions_version_conflict', 409, { project: projectView(row, attached.teams.get(id) ?? [], attached.automations.get(id) ?? []) });
        }
        const now = new Date();
        const version = row.instructionsVersion + 1;
        const summary = input.summary?.trim() || null;
        const updated = await tx.project.updateMany({
            where: { id, accountId, instructionsVersion: input.ifVersion },
            data: { instructions: input.instructions, instructionsVersion: version, instructionsUpdatedBy: updatedBy, instructionsUpdatedAt: now, instructionsSummary: summary, updatedAt: now },
        });
        requireProject(updated.count === 1, 'instructions_version_conflict', 409);
        await tx.projectInstructionsRevision.create({ data: { projectId: id, version, instructions: input.instructions, updatedBy, summary, createdAt: now } });
        const attached = await attachedIds(tx, [id]);
        return projectView(await loadProject(tx, accountId, id), attached.teams.get(id) ?? [], attached.automations.get(id) ?? []);
    });
}

export async function listInstructionRevisions(accountId: string, id: string): Promise<ProjectInstructionsRevisionView[]> {
    return run(async tx => {
        await loadProject(tx, accountId, id);
        const rows = await tx.projectInstructionsRevision.findMany({ where: { projectId: id }, orderBy: { version: 'desc' }, take: 100 });
        return rows.map(r => ({ version: r.version, instructions: r.instructions, updatedBy: r.updatedBy, summary: r.summary, createdAt: r.createdAt.getTime() }));
    });
}

// ─── Members ──────────────────────────────────────────────────────────────

export async function addMembers(accountId: string, id: string, input: ProjectMembersAdd): Promise<ProjectMemberView[]> {
    return run(async tx => {
        await loadProject(tx, accountId, id);
        await placeMembers(tx, accountId, id, input.sessionIds, input.via ?? 'explicit');
        return membersOf(tx, accountId, [id]);
    });
}

/** Removes an explicit membership; a team-derived member leaves only when its team is detached. */
export async function removeMember(accountId: string, id: string, sessionId: string): Promise<{ removed: boolean }> {
    return run(async tx => {
        await loadProject(tx, accountId, id);
        const removed = await tx.projectMember.deleteMany({ where: { projectId: id, sessionId, accountId } });
        await tx.projectPresence.deleteMany({ where: { projectId: id, sessionId } });
        await tx.projectReadCursor.deleteMany({ where: { projectId: id, sessionId } });
        return { removed: removed.count > 0 };
    });
}

// ─── Teams ────────────────────────────────────────────────────────────────

type TeamRow = { id: string; machineId: string; version: number; projectId: string | null; state: { name?: string; archivedAt?: number; creationLaunch?: { directory?: string; goal?: string }; defaults?: { assistant?: string; model?: string; maxParallel?: number }; bots?: { id?: string; root?: boolean; directory?: string | null }[] } };
async function loadTeamRow(tx: Tx, accountId: string, teamId: string): Promise<TeamRow> {
    const teams = await tx.$queryRaw<TeamRow[]>`SELECT "id","machineId","version","projectId","state" FROM "AgentTeam" WHERE "id"=${teamId} AND "accountId"=${accountId}`;
    requireProject(teams[0], 'team_not_found', 404);
    return teams[0];
}

/**
 * `attach-project`: the team's machine must be one of the project's folder
 * machines. B-726: when it is not, the team's own directory (launch directory,
 * else the lead's) is added as a folder — the team brings its workplace with
 * it — and only a team with no known directory (or a full folder list) is
 * refused. A project without folders accepts any team. Project defaults are snapshotted only into team default fields the
 * team has not set itself; the team keeps its own afterwards.
 */
export async function attachTeam(accountId: string, projectId: string, teamId: string): Promise<{ teamId: string; projectId: string }> {
    return run(async tx => {
        await attachTeamTx(tx, accountId, projectId, teamId);
        return { teamId, projectId };
    });
}

async function attachTeamTx(tx: Tx, accountId: string, projectId: string, teamId: string): Promise<void> {
    const project = await loadProject(tx, accountId, projectId);
    const team = await loadTeamRow(tx, accountId, teamId);
    const folders = readFolders(project.folders);
    // A project with no folders yet has no workplace to check against (e.g. a same-name project for a team that never started).
    if (folders.length > 0 && !teamMachineAllowed(folders, team.machineId)) {
        const folder = await teamFolder(tx, accountId, team);
        requireProject(folder && folders.length < PROJECT_LIMITS.folders, 'team_machine_not_in_project', 400, { machineId: team.machineId });
        await tx.project.update({ where: { id: projectId }, data: { folders: normalizeFolders([...folders, { ...folder, primary: folders.length === 0 }]), updatedAt: new Date() } });
    }
    const defaults = snapshotTeamDefaults(team.state?.defaults, readDefaults(project.defaults));
    if (defaults) {
        const state = JSON.stringify({ ...team.state, defaults });
        const updated = await tx.$executeRaw`UPDATE "AgentTeam" SET "projectId"=${projectId}, "state"=${state}::jsonb, "version"="version"+1, "updatedAt"=now() WHERE "id"=${teamId} AND "accountId"=${accountId} AND "version"=${team.version}`;
        requireProject(updated === 1, 'transaction_conflict', 409);
    } else {
        await tx.$executeRaw`UPDATE "AgentTeam" SET "projectId"=${projectId} WHERE "id"=${teamId} AND "accountId"=${accountId}`;
    }
}

/**
 * Where a team works: its launch directory, else its lead's requested spawn
 * directory, else its lead's directory, else `fallback` (the creating
 * session's folder). B-755: a candidate inside a team worktree
 * (`<happy home>/teams/worktrees/<op id>`, a member's throwaway checkout) is
 * followed back through that spawn operation to its repository; one that
 * cannot be is skipped, so the project gets no folder rather than a worktree.
 */
async function teamFolder(tx: Tx, accountId: string, team: TeamRow, fallback?: string): Promise<{ machineId: string; path: string } | null> {
    const root = team.state?.bots?.find(b => b.root);
    const spawns = root?.id ? await tx.$queryRaw<{ directory: string | null }[]>`
        SELECT "state"->>'directory' AS "directory" FROM "TeamOperation"
        WHERE "teamId"=${team.id} AND "state"->>'type'='spawn' AND "state"->>'botId'=${root.id} AND "state"->>'directory' IS NOT NULL
        ORDER BY "createdAt" ASC, "id" ASC LIMIT 1` : [];
    // B-822: a spawn compaction archived still names its worktree's repository.
    const sourceOf = async (operationId: string) => (await tx.$queryRaw<{ directory: string | null }[]>`
        SELECT o."state"->>'directory' AS "directory" FROM "TeamOperation" o JOIN "AgentTeam" t ON t."id"=o."teamId"
        WHERE o."id"=${operationId} AND t."accountId"=${accountId} AND t."machineId"=${team.machineId} AND o."state"->>'type'='spawn'
        UNION ALL
        SELECT a."state"->>'directory' AS "directory" FROM "TeamArchive" a JOIN "AgentTeam" t ON t."id"=a."teamId"
        WHERE a."kind"='operation' AND a."id"=${operationId} AND t."accountId"=${accountId} AND t."machineId"=${team.machineId} AND a."state"->>'type'='spawn'`)[0]?.directory ?? null;
    for (const candidate of [team.state?.creationLaunch?.directory, spawns[0]?.directory, root?.directory, fallback]) {
        if (!candidate) continue;
        const path = await resolveTeamWorktreePath(candidate, sourceOf);
        if (path) return { machineId: team.machineId, path };
    }
    return null;
}

/**
 * B-726: binds a team created in this transaction (`createTeam`) to a project
 * per `choice` (precedence projectId > inheritFromSessionId's project > create).
 * Projects switched off → the team is simply created without one. A
 * same-name project is idempotent by the team's id, so a retried create never
 * makes two.
 */
export async function bindNewTeamProjectTx(tx: Tx, accountId: string, teamId: string, choice: TeamProjectChoice): Promise<void> {
    if (process.env.VH_PROJECTS_ENABLED === 'false') return;
    let projectId = choice.projectId ?? null;
    if (!projectId && choice.inheritFromSessionId) {
        const own = await tx.projectMember.findFirst({ where: { sessionId: choice.inheritFromSessionId, accountId }, select: { projectId: true } });
        if (own && await tx.project.findFirst({ where: { id: own.projectId, accountId, archivedAt: null }, select: { id: true } })) projectId = own.projectId;
    }
    if (!projectId && (choice.create || choice.inheritFromSessionId)) {
        try {
            projectId = (await createSameNameProjectTx(tx, accountId, teamId, `team-create:${teamId}`, choice.directory)).id;
        } catch (error) {
            // At the project cap the team still starts, just without a project (the count check runs before any write).
            if (error instanceof ProjectError && error.code === 'project_count_quota_exceeded') return;
            throw error;
        }
    }
    if (projectId) await attachTeamTx(tx, accountId, projectId, teamId);
}

async function createSameNameProjectTx(tx: Tx, accountId: string, teamId: string, requestId: string, directory?: string): Promise<ProjectRow> {
    const team = await loadTeamRow(tx, accountId, teamId);
    const folder = await teamFolder(tx, accountId, team, directory);
    const name = (team.state?.name ?? 'Team').trim().slice(0, PROJECT_LIMITS.nameChars) || 'Team';
    // B-755: the project's context starts as the team's goal (the user edits it on the project page).
    const instructions = clipUtf8((team.state?.creationLaunch?.goal ?? '').trim(), PROJECT_LIMITS.instructionsBytes);
    return (await createProjectTx(tx, accountId, { name, requestId, folders: folder ? [{ ...folder, primary: true }] : [], ...(instructions ? { instructions } : {}) })).row;
}

/**
 * B-726 team-side binding (team settings, old-team one-click): attach to
 * `projectId`, detach (`projectId: null`), or create a same-name project and
 * attach (`create`, idempotent by `requestId`).
 */
export async function bindTeamProject(accountId: string, teamId: string, bind: TeamProjectBind): Promise<{ teamId: string; projectId: string | null; project: ProjectView | null }> {
    return run(async tx => {
        await loadTeamRow(tx, accountId, teamId);
        let projectId: string | null;
        if (bind.create) {
            projectId = (await createSameNameProjectTx(tx, accountId, teamId, `team-bind:${teamId}:${bind.requestId ?? 'default'}`)).id;
        } else {
            projectId = bind.projectId ?? null;
        }
        if (projectId) await attachTeamTx(tx, accountId, projectId, teamId);
        else await tx.$executeRaw`UPDATE "AgentTeam" SET "projectId"=NULL WHERE "id"=${teamId} AND "accountId"=${accountId}`;
        if (!projectId) return { teamId, projectId: null, project: null };
        const row = await loadProject(tx, accountId, projectId);
        const attached = await attachedIds(tx, [projectId]);
        return { teamId, projectId, project: projectView(row, attached.teams.get(projectId) ?? [], attached.automations.get(projectId) ?? []) };
    });
}

export async function detachTeam(accountId: string, projectId: string, teamId: string): Promise<{ detached: boolean }> {
    return run(async tx => {
        await loadProject(tx, accountId, projectId);
        const n = await tx.$executeRaw`UPDATE "AgentTeam" SET "projectId"=NULL WHERE "id"=${teamId} AND "accountId"=${accountId} AND "projectId"=${projectId}`;
        return { detached: n === 1 };
    });
}

// ─── Log ──────────────────────────────────────────────────────────────────

async function resolveLogRef(tx: Tx, projectId: string, ref: string): Promise<LogRow> {
    const parsed = parseLogRef(ref);
    const row = 'seq' in parsed
        ? await tx.projectLogEntry.findFirst({ where: { projectId, seq: parsed.seq } })
        : await tx.projectLogEntry.findFirst({ where: { projectId, id: parsed.id } });
    requireProject(row, 'log_entry_not_found', 404);
    return row;
}

/**
 * Append-only. An agent-authored note (authorSessionId set by the wrapper)
 * must come from a member and fits a rolling-hour budget (≤5, ≤2 decisions);
 * over budget answers 429 with a one-line alternative. User notes are not
 * budgeted. Editing = a new entry that `supersedes` the old one.
 */
export async function createLogEntry(accountId: string, projectId: string, input: ProjectLogCreate): Promise<ProjectLogEntryView> {
    return run(async tx => {
        await loadProject(tx, accountId, projectId);
        if (input.authorSessionId) {
            await requireMember(tx, accountId, projectId, input.authorSessionId);
            const recent = await tx.projectLogEntry.findMany({
                where: { authorSessionId: input.authorSessionId, createdAt: { gt: new Date(Date.now() - 3600_000) } },
                select: { kind: true },
            });
            const refusal = noteQuotaRefusal(recent, input.kind);
            if (refusal) throw new ProjectError('project_note_quota_exceeded', 429, refusal);
        }
        const supersedes = input.supersedes ? (await resolveLogRef(tx, projectId, input.supersedes)).id : null;
        const bumped = await tx.project.update({ where: { id: projectId }, data: { logSeq: { increment: 1 }, updatedAt: new Date() }, select: { logSeq: true } });
        const row = await tx.projectLogEntry.create({ data: {
            id: randomUUID(), projectId, seq: bumped.logSeq, kind: input.kind, title: input.title, body: input.body ?? '',
            authorSessionId: input.authorSessionId ?? null, authorUser: !input.authorSessionId, supersedes,
        } });
        return logView(row);
    });
}

/** The owner may revoke anything; a session only what it wrote. Idempotent. */
export async function revokeLogEntry(accountId: string, projectId: string, ref: string, bySessionId?: string): Promise<ProjectLogEntryView> {
    return run(async tx => {
        await loadProject(tx, accountId, projectId);
        const row = await resolveLogRef(tx, projectId, ref);
        if (bySessionId) requireProject(row.authorSessionId === bySessionId, 'log_entry_not_owned', 409);
        const updated = row.revokedAt ? row : await tx.projectLogEntry.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
        return logView(updated);
    });
}

export async function listLog(accountId: string, projectId: string): Promise<ProjectLogEntryView[]> {
    return run(async tx => {
        await loadProject(tx, accountId, projectId);
        return logViews(await tx.projectLogEntry.findMany({ where: { projectId }, orderBy: { seq: 'asc' } }));
    });
}

// ─── Presence (daemon-written) ────────────────────────────────────────────

/**
 * The daemon reports what it knows about its live sessions (the server cannot
 * decrypt metadata). Only rows for sessions that are project members are kept.
 * Fields are merged (omitted = unchanged), so daemon and wrapper writes compose.
 * It has its own rate bucket (`project_presence`), so presence never spends
 * the `session_state` budget (B-644 acceptance: no session-state 429). The
 * answer maps each reported session to its project so the daemon learns
 * membership without another request.
 */
export async function putPresence(accountId: string, input: ProjectPresencePut): Promise<{ memberships: Record<string, string> }> {
    assertProjectsEnabled();
    try {
        await enforceAccountWriteRate({ accountId, resource: 'project_presence', envName: 'MAX_PROJECT_PRESENCE_WRITES_PER_ACCOUNT_PER_MINUTE', fallback: 120 });
    } catch (error) { return mapError(error); }
    return run(async tx => {
        const memberships: Record<string, string> = {};
        const reported = [...new Map(input.sessions.map(s => [s.sessionId, s])).values()];
        const owned = new Set((await tx.session.findMany({ where: { accountId, id: { in: reported.map(s => s.sessionId) } }, select: { id: true } })).map(s => s.id));
        const now = new Date();
        for (const entry of reported) {
            if (!owned.has(entry.sessionId)) continue;
            const m = await membershipOf(tx, accountId, entry.sessionId);
            if (!m) { await tx.projectPresence.deleteMany({ where: { sessionId: entry.sessionId, accountId } }); continue; }
            memberships[entry.sessionId] = m.projectId;
            // Partial update: the daemon (agent/state/branch) and the wrapper (title/doing/injected version)
            // both report; a field left out keeps its stored value instead of being nulled.
            const fields = {
                title: entry.title, agent: entry.agent, machine: entry.machine, branch: entry.branch, state: entry.state, doing: entry.doing,
                injectedInstructionsVersion: entry.injectedInstructionsVersion, capabilities: entry.capabilities,
            };
            const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
            const base = { projectId: m.projectId, accountId, machineId: input.machineId, updatedAt: now };
            await tx.projectPresence.upsert({ where: { sessionId: entry.sessionId }, create: { sessionId: entry.sessionId, ...base, ...given }, update: { ...base, ...given } });
            await tx.projectMember.updateMany({ where: { sessionId: entry.sessionId, accountId }, data: { machineId: input.machineId } });
        }
        if (input.gone?.length) {
            await tx.projectPresence.updateMany({ where: { accountId, machineId: input.machineId, sessionId: { in: input.gone } }, data: { state: 'offline', updatedAt: now } });
        }
        return { memberships };
    });
}

// ─── Offline messages ─────────────────────────────────────────────────────

/** Q4: bodies of messages delivered more than 7 days ago are erased; metadata stays. */
async function purgeDeliveredBodies(tx: Tx, accountId: string): Promise<void> {
    const cutoff = new Date(Date.now() - PROJECT_LIMITS.deliveredMessageRetentionMs);
    await tx.projectMessage.updateMany({ where: { accountId, deliveredAt: { lt: cutoff }, body: { not: null } }, data: { body: null } });
}

/** Both ends must belong to this project. Undelivered mail per recipient is capped. */
export async function createMessage(accountId: string, projectId: string, input: ProjectMessageCreate): Promise<ProjectMessageView> {
    return run(async tx => {
        await loadProject(tx, accountId, projectId);
        await requireMember(tx, accountId, projectId, input.fromSessionId);
        await requireMember(tx, accountId, projectId, input.toSessionId);
        const pending = await tx.projectMessage.count({ where: { toSessionId: input.toSessionId, deliveredAt: null } });
        requireProject(pending < MAX_UNDELIVERED_PER_RECIPIENT, 'message_quota_exceeded', 429, { limit: MAX_UNDELIVERED_PER_RECIPIENT });
        await purgeDeliveredBodies(tx, accountId);
        const row = await tx.projectMessage.create({ data: { id: randomUUID(), projectId, accountId, fromSessionId: input.fromSessionId, toSessionId: input.toSessionId, body: input.body } });
        return messageView(row);
    });
}

export async function listUndelivered(accountId: string, sessionId: string): Promise<ProjectMessageView[]> {
    return run(async tx => {
        const rows = await tx.projectMessage.findMany({ where: { accountId, toSessionId: sessionId, deliveredAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 50 });
        return rows.map(messageView);
    });
}

/** Called by the recipient wrapper after the messages went into a turn. Idempotent. */
export async function markDelivered(accountId: string, sessionId: string, messageIds: string[]): Promise<{ delivered: number }> {
    return run(async tx => {
        const n = await tx.projectMessage.updateMany({ where: { accountId, toSessionId: sessionId, id: { in: messageIds }, deliveredAt: null }, data: { deliveredAt: new Date() } });
        await purgeDeliveredBodies(tx, accountId);
        return { delivered: n.count };
    });
}

// ─── Wrapper reads ────────────────────────────────────────────────────────

function liveDecisions(rows: LogRow[]): LogRow[] {
    const superseded = new Set(rows.filter(r => r.supersedes && !r.revokedAt).map(r => r.supersedes!));
    return rows.filter(r => r.kind === 'decision' && !r.revokedAt && !superseded.has(r.id));
}

/**
 * Everything a wrapper needs for the first-turn prefix and `project_context`.
 * Not a member (or the project is archived) → `project: null`. Unless `peek`,
 * the read moves the session's "since last read" cursor.
 */
export async function sessionContext(accountId: string, sessionId: string, opts: { full?: boolean; peek?: boolean } = {}): Promise<ProjectSessionContext> {
    return run(async tx => {
        const now = new Date();
        const empty: ProjectSessionContext = { project: null, via: null, team: null, decisions: [], log: [], sessions: [], unread: [], asOf: now.getTime(), previousReadAt: 0 };
        const m = await membershipOf(tx, accountId, sessionId);
        if (!m) return empty;
        const project = await tx.project.findFirst({ where: { id: m.projectId, accountId, archivedAt: null } });
        if (!project) return empty;
        const cursor = await tx.projectReadCursor.findUnique({ where: { sessionId } });
        const previousReadAt = cursor && cursor.projectId === project.id ? cursor.readAt.getTime() : 0;
        const logRows = await tx.projectLogEntry.findMany({ where: { projectId: project.id }, orderBy: { seq: 'asc' } });
        const decisions = liveDecisions(logRows).slice(-CONTEXT_DECISIONS).map(r => ({ id: r.id, seq: r.seq, title: r.title, createdAt: r.createdAt.getTime() }));
        const log = opts.full ? logViews(logRows) : logViews(logRows).filter(e => e.createdAt > previousReadAt || (e.revokedAt ?? 0) > previousReadAt);
        const presence = await tx.projectPresence.findMany({ where: { projectId: project.id, accountId, sessionId: { not: sessionId }, OR: [{ state: null }, { state: { not: 'offline' } }] }, orderBy: { updatedAt: 'desc' }, take: opts.full ? 200 : CONTEXT_SESSIONS });
        const unread = await tx.projectMessage.findMany({ where: { accountId, toSessionId: sessionId, deliveredAt: null }, orderBy: { createdAt: 'asc' }, take: opts.full ? 50 : CONTEXT_UNREAD });
        if (!opts.peek) {
            await tx.projectReadCursor.upsert({ where: { sessionId }, create: { sessionId, projectId: project.id, readAt: now }, update: { projectId: project.id, readAt: now } });
        }
        return {
            project: { id: project.id, name: project.name, goal: project.goal, instructions: project.instructions, instructionsVersion: project.instructionsVersion },
            via: m.via, team: m.teamId ? { id: m.teamId, name: m.teamName ?? m.teamId, lead: m.teamLead === true } : null,
            decisions, log, sessions: presence.map(presenceView),
            unread: unread.map(u => ({ id: u.id, fromSessionId: u.fromSessionId, body: u.body, createdAt: u.createdAt.getTime() })),
            asOf: now.getTime(), previousReadAt,
        };
    });
}

/**
 * Next-turn piggyback (D): what changed since `since` (ms). Read-only — it
 * never wakes anything; the wrapper calls it only before a turn that is
 * already going to run.
 */
export async function sessionDigest(accountId: string, sessionId: string, since: number): Promise<ProjectDigest> {
    return run(async tx => {
        const now = Date.now();
        const sinceDate = new Date(since);
        const m = await membershipOf(tx, accountId, sessionId);
        const project = m ? await tx.project.findFirst({ where: { id: m.projectId, accountId, archivedAt: null } }) : null;
        if (!project) return { projectId: null, name: null, instructions: null, decisions: [], revoked: [], messages: [], asOf: now };
        const instructions = project.instructionsUpdatedAt && project.instructionsUpdatedAt > sinceDate
            ? { version: project.instructionsVersion, summary: project.instructionsSummary } : null;
        const newDecisions = await tx.projectLogEntry.findMany({ where: { projectId: project.id, kind: 'decision', createdAt: { gt: sinceDate }, revokedAt: null }, orderBy: { seq: 'asc' }, take: 5 });
        const revoked = await tx.projectLogEntry.findMany({ where: { projectId: project.id, revokedAt: { gt: sinceDate } }, orderBy: { seq: 'asc' }, take: 5 });
        const messages = await tx.projectMessage.findMany({ where: { accountId, toSessionId: sessionId, deliveredAt: null }, orderBy: { createdAt: 'asc' }, take: 3 });
        return {
            projectId: project.id, name: project.name, instructions,
            decisions: newDecisions.map(r => ({ id: r.id, seq: r.seq, title: r.title })),
            revoked: revoked.map(r => ({ id: r.id, seq: r.seq, title: r.title })),
            messages: messages.map(u => ({ id: u.id, fromSessionId: u.fromSessionId, body: u.body, createdAt: u.createdAt.getTime() })),
            asOf: now,
        };
    });
}

/** The project a session belongs to, if any (cheap read for the daemon / CLI). */
export async function sessionMembership(accountId: string, sessionId: string): Promise<{ projectId: string | null; via: string | null }> {
    return run(async tx => {
        const m = await membershipOf(tx, accountId, sessionId);
        return { projectId: m?.projectId ?? null, via: m?.via ?? null };
    });
}

export { ProjectError };

/** The longest prefix of `text` that fits in `bytes` UTF-8 bytes, never splitting a character. */
function clipUtf8(text: string, bytes: number): string {
    if (Buffer.byteLength(text, 'utf8') <= bytes) return text;
    let out = '';
    for (const ch of text) {
        if (Buffer.byteLength(out + ch, 'utf8') > bytes) break;
        out += ch;
    }
    return out;
}
