import type { TeamCapacity, TeamCapacityMetric, TeamMessage, TeamOperation, TeamState, TeamTask } from '@slopus/happy-wire';

/**
 * B-822 (`specs/2026-10-team-compaction.md`): a long-running team never reaches its record limits.
 * The incident: after 5 days a production team held 169 tasks, 996 messages and 330 operations
 * (≈2.03 MB) and every write failed with team_size_limit. Closed work — a done / cancelled task,
 * its delivered or cancelled messages, its finished operations — moves to `TeamArchive`; open work
 * never does. The `*Archivable` predicates are the safety rule (store.persistTransition refuses any
 * other removal); `compactTeam` is the policy (age, then pressure).
 */
export const TEAM_LIMITS: Record<TeamCapacityMetric, number> = { bytes: 2_000_000, messages: 2000, operations: 1000, tasks: 200 };
/** Closed work stays visible this long before it is archived. */
export const TEAM_COMPACT_AGE_MS = 24 * 60 * 60 * 1000;
/** Above this share of any limit, compaction stops waiting for the age (then 1 h, then the grace). */
export const TEAM_COMPACT_PRESSURE = 0.5;
/** Even under pressure closed work stays this long, so a lead still reads a child it just accepted. */
export const TEAM_COMPACT_MIN_AGE_MS = 10 * 60 * 1000;
const AGE_TIERS = [TEAM_COMPACT_AGE_MS, 60 * 60 * 1000, TEAM_COMPACT_MIN_AGE_MS];
export const TEAM_CAPACITY_WARN = 0.8;
const TEAM_CAPACITY_CLEAR = 0.7;

const closed = (task: TeamTask | undefined) => task?.status === 'done' || task?.status === 'cancelled';
const terminal = (m: TeamMessage) => m.deliveredAt !== null || m.cancelledAt !== undefined;
/** Nothing acts on it again: completed, or a launch whose task closed before it ran. */
const inert = (o: TeamOperation) => o.status === 'completed' || (o.status === 'failed' && o.error === 'task_closed_before_spawn');

/** The spawn `teamBotRepository` reads for each bot (its first with a directory). Never archived. */
export function repositorySpawnIds(team: Pick<TeamState, 'operations'>): Set<string> {
    const bots = new Set<string>(); const ids = new Set<string>();
    for (const o of team.operations) if (o.type === 'spawn' && o.directory && !bots.has(o.botId)) { bots.add(o.botId); ids.add(o.id); }
    return ids;
}
/** `team` is the state the message would leave; its task is closed there or already archived. Schedule
 *  messages have their own retention (schedules.pruneScheduleMessages). */
export function messageArchivable(m: TeamMessage, team: Pick<TeamState, 'tasks'>): boolean {
    if (!terminal(m) || m.scheduleId) return false;
    if (m.taskId === null) return true;
    const task = team.tasks.find(t => t.id === m.taskId);
    return !task || closed(task);
}
/** The daemon still reads a spawn whose wrapper is bound — its member's current (generation, session),
 *  which recoverScope rebuilds the scope from — or that an unfinished stop cleans up (its worktree
 *  receipt is found by the same triple, worker.ts). */
function spawnInUse(o: TeamOperation, team: Pick<TeamState, 'bots' | 'operations'>): boolean {
    if (o.type !== 'spawn') return false;
    const same = (b: { generation: number; sessionId: string | null }) => o.sessionId !== null && b.generation === o.generation && b.sessionId === o.sessionId;
    const bot = team.bots.find(b => b.id === o.botId);
    if (bot && same(bot)) return true;
    return team.operations.some(stop => stop.type === 'stop' && stop.status !== 'completed' && stop.botId === o.botId && same(stop));
}
/** `team`: the state the operation would leave; `repository`: `repositorySpawnIds` of the state before the removal. */
export function operationArchivable(o: TeamOperation, team: Pick<TeamState, 'tasks' | 'bots' | 'operations'>, repository: Set<string>): boolean {
    if (!inert(o) || repository.has(o.id) || spawnInUse(o, team)) return false;
    const task = team.tasks.find(t => t.id === o.taskId);
    return !task || closed(task);
}
/** Closed with no cleanup waiting, no open descendant (agents read a subtree through its ancestors),
 *  no operation that may still act and no undelivered message (an agent only receives messages of
 *  tasks it can see). `team` may or may not still contain `task`. */
export function taskArchivable(task: TeamTask, team: Pick<TeamState, 'tasks' | 'messages' | 'operations'>): boolean {
    if (!closed(task) || task.cleanup === 'pending' || task.cleanup === 'failed') return false;
    const byId = new Map(team.tasks.map(t => [t.id, t])); byId.set(task.id, task);
    for (const open of team.tasks) {
        if (closed(open)) continue;
        const seen = new Set<string>();
        for (let p = open.parentTaskId; p && !seen.has(p); p = byId.get(p)?.parentTaskId ?? null) {
            if (p === task.id) return false;
            seen.add(p);
        }
    }
    return team.operations.every(o => o.taskId !== task.id || inert(o)) && team.messages.every(m => m.taskId !== task.id || terminal(m));
}

/** `bytes`: the caller's `JSON.stringify(team).length` when it already has it. */
export function teamCapacity(team: TeamState, bytes = JSON.stringify(team).length): TeamCapacity {
    const used: Record<TeamCapacityMetric, number> = { bytes, messages: team.messages.length, operations: team.operations.length, tasks: team.tasks.length };
    const metrics = Object.fromEntries((Object.keys(TEAM_LIMITS) as TeamCapacityMetric[]).map(k => [k, { used: used[k], limit: TEAM_LIMITS[k] }])) as TeamCapacity['metrics'];
    const full = (Object.keys(metrics) as TeamCapacityMetric[]).filter(k => metrics[k].used >= metrics[k].limit * TEAM_CAPACITY_WARN);
    return { metrics, ...(full.length ? { warning: capacityWarning(metrics, full) } : {}) };
}
function capacityWarning(metrics: TeamCapacity['metrics'], full: TeamCapacityMetric[]): string {
    return `Team record near its limits: ${full.map(k => `${k} ${metrics[k].used}/${metrics[k].limit} (${Math.round(metrics[k].used / metrics[k].limit * 100)}%)`).join(', ')}. Closed work is archived automatically, so this is open work: accept, cancel or hand off finished tasks, or ask the owner to archive this team and start a new one before writes are refused. 团队记录接近上限：请验收/取消已完成的任务，或请 Owner 归档本团队并新建。`;
}

/**
 * Pure policy: archive what is archivable and old enough; while any limit is ≥ 50% used, take
 * younger closed work too. Returns `input` itself when nothing moves (no write needed).
 */
export function compactTeam(input: TeamState, now: number): TeamState {
    let team = stampLegacyClosedAt(input, now);
    for (const [tier, age] of AGE_TIERS.entries()) {
        if (tier > 0 && !underPressure(team)) break;
        team = compactOnce(team, now - age, now);
    }
    return team;
}
/**
 * Tasks closed before B-822 carry no closedAt. The first time compaction sees one it gets `now`, so a
 * task closed shortly before the deploy keeps its full 24 h — except under pressure, where its last
 * message / operation stands in (the incident team must be unblocked by its next write).
 */
function stampLegacyClosedAt(team: TeamState, now: number): TeamState {
    if (!team.tasks.some(t => closed(t) && t.closedAt === undefined)) return team;
    const pressure = underPressure(team);
    const lastActivity = new Map<string, number>();
    const touch = (taskId: string | null, at: number) => { if (taskId) lastActivity.set(taskId, Math.max(lastActivity.get(taskId) ?? 0, at)); };
    for (const m of team.messages) touch(m.taskId, Math.max(m.createdAt, m.deliveredAt ?? 0, m.cancelledAt ?? 0));
    for (const o of team.operations) touch(o.taskId, Math.max(o.createdAt, o.claimedAt ?? 0));
    return { ...team, tasks: team.tasks.map(t => closed(t) && t.closedAt === undefined ? { ...t, closedAt: pressure ? lastActivity.get(t.id) ?? 0 : now } : t) };
}
function underPressure(team: TeamState): boolean {
    const counted = team.messages.length >= TEAM_LIMITS.messages * TEAM_COMPACT_PRESSURE || team.operations.length >= TEAM_LIMITS.operations * TEAM_COMPACT_PRESSURE || team.tasks.length >= TEAM_LIMITS.tasks * TEAM_COMPACT_PRESSURE;
    return counted || JSON.stringify(team).length >= TEAM_LIMITS.bytes * TEAM_COMPACT_PRESSURE;
}
function compactOnce(team: TeamState, cutoff: number, now: number): TeamState {
    const tasks = new Set(team.tasks.filter(t => (t.closedAt ?? now) <= cutoff && taskArchivable(t, team)).map(t => t.id));
    const remaining = { tasks: team.tasks.filter(t => !tasks.has(t.id)), bots: team.bots, operations: team.operations };
    const repository = repositorySpawnIds(team);
    const messages = new Set(team.messages.filter(m => Math.max(m.deliveredAt ?? 0, m.cancelledAt ?? 0, m.createdAt) <= cutoff && messageArchivable(m, remaining)).map(m => m.id));
    const operations = new Set(team.operations.filter(o => o.createdAt <= cutoff && operationArchivable(o, remaining, repository)).map(o => o.id));
    if (!tasks.size && !messages.size && !operations.size) return team;
    const prior = team.compacted ?? { messages: 0, operations: 0, tasks: 0, at: now };
    return {
        ...team,
        tasks: remaining.tasks,
        messages: team.messages.filter(m => !messages.has(m.id)),
        operations: team.operations.filter(o => !operations.has(o.id)),
        compacted: { messages: prior.messages + messages.size, operations: prior.operations + operations.size, tasks: prior.tasks + tasks.size, at: now },
    };
}

/**
 * Mutates `team` (inside reduceTeam): the first time a metric reaches 80% the lead gets one system
 * message (taskId null, so it reaches the lead's session like a schedule). A metric is warned again
 * only after it dropped below 70%. Returns whether it added the message.
 */
export function warnCapacity(team: TeamState, bytes: number, now: number, id: () => string): boolean {
    const { metrics } = teamCapacity(team, bytes);
    const warned = new Set(team.capacityWarned ?? []);
    const fresh: TeamCapacityMetric[] = [];
    for (const key of Object.keys(metrics) as TeamCapacityMetric[]) {
        const ratio = metrics[key].used / metrics[key].limit;
        if (ratio >= TEAM_CAPACITY_WARN && !warned.has(key)) { warned.add(key); fresh.push(key); }
        else if (ratio < TEAM_CAPACITY_CLEAR) warned.delete(key);
    }
    if (warned.size) team.capacityWarned = [...warned]; else delete team.capacityWarned;
    const lead = team.bots.find(b => b.root && b.sessionId) ?? team.bots.find(b => b.root);
    if (!fresh.length || !lead || team.archivedAt !== undefined || team.messages.length >= TEAM_LIMITS.messages) return false;
    team.messages.push({ id: id(), taskId: null, senderBotId: null, source: 'system', recipientBotId: lead.id, body: capacityWarning(metrics, fresh), deliveredAt: null, createdAt: now });
    return true;
}
