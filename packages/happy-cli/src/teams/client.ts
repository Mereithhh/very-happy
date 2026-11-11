import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname } from 'node:path';
import { isInsideTeamWorktree, rebaseTeamWorktreePath } from '@slopus/happy-wire';
import { configuration } from '@/configuration';
import { readCredentialsForConfiguredRelay, readSettings, readPersistedSessions } from '@/persistence';
import { readTeamScope, teamScopePath, writeTeamScope } from './context';
import { readTeamExitMarker, teamExitedMessage } from './exitNotice';

/** B-912: bounded automatic backoff on HTTP 429 (10-25: four sessions' submits never landed). */
export const TEAM_RATE_LIMIT_RETRIES = 3;
export const TEAM_RATE_LIMIT_BUDGET_MS = 30_000;
export type TeamRequestTiming = { sleep?: (ms: number) => Promise<void>; now?: () => number; random?: () => number };
/** A 429 that waiting will not heal: a capacity code from older servers (B-822) or a count / size quota. */
export const permanentTeamRefusal = (body: unknown) => {
    const code = (body as Record<string, unknown> | null)?.error;
    return typeof code === 'string' && (code.endsWith('_limit') || code.endsWith('_quota_exceeded'));
};
/** `Retry-After` in seconds or as an HTTP date; else 1 s, 2 s, 4 s with ±20 % jitter. */
export function teamRetryDelayMs(header: string | null, retry: number, now: number, random: () => number = Math.random): number {
    const value = header?.trim() ?? '';
    if (/^\d+(\.\d+)?$/.test(value)) return Math.max(250, Math.ceil(Number(value) * 1000));
    const date = value ? Date.parse(value) : NaN;
    if (Number.isFinite(date)) return Math.max(250, date - now);
    return Math.round(1000 * 2 ** retry * (0.8 + 0.4 * random()));
}
export function teamRateLimitedMessage(retries: number, waitedMs: number, retryAfterMs: number | null): string {
    const later = retryAfterMs !== null && retryAfterMs > 1000 ? ` The server asked to wait ${Math.ceil(retryAfterMs / 1000)} s.` : '';
    return `Teams is rate limiting this session (HTTP 429); retried ${retries} time${retries === 1 ? '' : 's'} over ${Math.round(waitedMs / 1000)} s with the same requestId.${later} Do other work for a minute, then call again with the same requestId and arguments (safe: it cannot apply twice). 团队服务限流，已自动重试；稍后用同一 requestId 重试即可。`;
}

// Never propagate HTTP bodies/errors: upstream diagnostics may contain credentials.
export async function teamRequest(path: string, method: string, token: string, scoped: boolean, body?: unknown, timing: TeamRequestTiming = {}): Promise<any> {
    const sleep = timing.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const now = timing.now ?? Date.now;
    const started = now();
    // The same serialized body on every try: its requestId makes a retried write idempotent on the server.
    const payload = body === undefined ? undefined : JSON.stringify(body);
    for (let retries = 0; ; retries++) {
        const response = await fetch(`${configuration.serverUrl}${path}`, {
            method, redirect: 'error', headers: { 'content-type': 'application/json', ...(scoped ? { 'x-happy-team-token': token } : { authorization: `Bearer ${token}` }) },
            body: payload, signal: AbortSignal.timeout(25_000),
        }).catch(() => { throw new Error('Teams connection failed; outcome may be unknown. Reuse the request ID when retrying.'); });
        if (response.ok) {
            try { return await response.json(); } catch { throw new Error('Teams returned an invalid response'); }
        }
        // B-730: the one refusal the model must read verbatim. Only allow-listed, length-capped fields leave this function.
        // B-822: every 4xx names its code — a full team used to answer 429 and read as rate limiting.
        const refusal = response.status >= 400 && response.status < 500 ? await response.json().catch(() => null) : null;
        if (response.status === 429 && !permanentTeamRefusal(refusal)) {
            const header = response.headers.get('retry-after');
            const wait = teamRetryDelayMs(header, retries, now(), timing.random);
            const elapsed = now() - started;
            if (retries < TEAM_RATE_LIMIT_RETRIES && elapsed + wait <= TEAM_RATE_LIMIT_BUDGET_MS) { await sleep(wait); continue; }
            throw new Error(teamRateLimitedMessage(retries, elapsed, header === null ? null : wait));
        }
        if (refusal?.error === 'session_in_other_team') throw new SessionInOtherTeamError(typeof refusal.teamId === 'string' ? refusal.teamId : '', typeof refusal.teamName === 'string' ? refusal.teamName : '');
        throw new Error(teamRefusalMessage(response.status, refusal, (body as { action?: { type?: unknown } } | undefined)?.action?.type));
    }
}
/**
 * B-775: a 409 names its reason (a snake_case code; nothing else from the body unless listed
 * here). A bare "HTTP 409" left a lead guessing why work for a member never started.
 */
export function teamRefusalMessage(status: number, body: unknown, actionType?: unknown): string {
    const field = (key: string, max: number) => { const value = (body as Record<string, unknown> | null)?.[key]; return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : ''; };
    const code = field('error', 64);
    if (!/^[a-z_]+$/.test(code)) return `Teams request failed (HTTP ${status})`;
    // B-912 (B-786): members cannot message each other; the refusal used to be a bare 403 / 404.
    if (actionType === 'message' && (code === 'recipient_outside_task' || code === 'task_not_found')) return teamMessageViaLeadMessage(code, field('ownerBotId', 128));
    if (code === 'bot_cleanup_failed') {
        const reason = field('cleanupError', 300);
        return `Teams request refused (bot_cleanup_failed): the cleanup of member "${field('botName', 128) || 'this member'}" failed${reason ? ` (${reason})` : ''} and still holds its session, so new work for it could not start. Only the owner can retry that cleanup or mark it handled on the team page (需要处理). Delegate to another member (omit assigneeBotId) meanwhile. 该成员的清理失败且仍占用会话，派给它的任务无法启动；请改派给其他成员，并请 Owner 在团队页「需要处理」重试清理或标记已处理。`;
    }
    if (code.endsWith('_limit')) {
        // B-822: 409 from current servers, 429 from older ones — either way a capacity limit, not throttling.
        const count = (key: string) => { const value = (body as Record<string, unknown>)[key]; return typeof value === 'number' && Number.isFinite(value) ? value : null; };
        const used = count('used'), limit = count('limit');
        return `Teams request refused (${code}${used !== null && limit !== null ? `: ${used}/${limit}` : ''}): ${TEAM_LIMIT_EXPLANATION}`;
    }
    // B-877b: a team archived under a live session (members, or a lead that has not restarted yet).
    if (code === 'team_archived') return TEAM_ARCHIVED_MESSAGE;
    // B-927a: the server refuses a token that is not a signed-in person for owner-only steps.
    if (code === 'owner_login_required') return teamOwnerLoginRequiredMessage(actionType, configuration.webappUrl);
    return `Teams request failed (HTTP ${status}: ${code})`;
}
export function teamOwnerLoginRequiredMessage(actionType: unknown, webappUrl: string): string {
    const step = typeof actionType === 'string' && /^[a-z-]{1,40}$/.test(actionType) ? ` (${actionType})` : '';
    return `Teams request refused (owner_login_required): this step${step} is the owner's and needs a signed-in person; the terminal and agents cannot do it for them. Ask the owner to do it in the signed-in web app (${webappUrl}): team settings for the execution mode, or the team page for taking over a Lead seat. Do not retry. 这一步只能由本人在已登录的网页上操作（${webappUrl}），终端和 agent 不能代办：执行模式在团队设置里改，接管 Lead 席位在团队页做。请告知 Owner，不要重试。`;
}
export function teamMessageViaLeadMessage(code: 'recipient_outside_task' | 'task_not_found', ownerBotId: string): string {
    const lead = /^[A-Za-z0-9_-]{1,128}$/.test(ownerBotId) ? `recipientBotId "${ownerBotId}"` : 'recipientBotId = the task\'s ownerBotId from team_inspect';
    const what = code === 'task_not_found' ? 'That task is not visible to you (another member\'s task, or a wrong taskId).' : 'A task message can only go to that task\'s owner or assignee.';
    return `Teams request refused (${code}): ${what} Members do not message each other directly: send it on your own task to your lead (${lead}) and ask them to forward it. 成员之间不能直发消息，请经 Lead 转达：在自己的任务上发给 Lead。`;
}
export const TEAM_ARCHIVED_MESSAGE = 'Teams request refused (team_archived): this team is archived, which is final; its tasks were cancelled and no team action can succeed. Do not retry or wait for team access. Tell the user the team has ended and do what they ask yourself, in this session. 团队已归档，团队工具不再可用；请直接告诉用户并自己完成用户的要求。';
/** B-822: shown for every `*_limit` refusal. */
export const TEAM_LIMIT_EXPLANATION = 'a team capacity limit was reached. This is not rate limiting: retrying or waiting will not help. Closed tasks, their delivered messages and finished operations are archived automatically, so what is left is open work — accept, cancel or hand off finished tasks (team_inspect shows `capacity`), or ask the user to archive this team and start a new one. 团队容量已满，不是限流，重试无效：请验收/取消已完成的任务，或请用户归档本团队后新建。';
export class TeamConnectionPreflightError extends Error {}
/** B-730: nothing was created or joined, so a Web adopt may change its request (confirm a transfer). */
export class SessionInOtherTeamError extends TeamConnectionPreflightError {
    readonly code = 'session_in_other_team';
    readonly teamId: string;
    readonly teamName: string;
    constructor(teamId: string, teamName: string) {
        const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 128);
        super(sessionInOtherTeamMessage(safe(teamName) || 'another team', safe(teamId)));
        this.teamId = safe(teamId);
        this.teamName = safe(teamName);
    }
}
export function sessionInOtherTeamMessage(teamName: string, teamId: string): string {
    return `This session is already the lead or a member of team "${teamName}"${teamId ? ` (${teamId})` : ''}. Call team_inspect and use team_delegate to assign work inside that team; do not create or join another team. 你已经是团队「${teamName}」的成员或负责人，请先 team_inspect，再用 team_delegate 在本团队内派活，不要新建或加入其他团队。`;
}
/**
 * B-730: shown when this session holds no team scope. A restarted lead used to read it as "make a team".
 * B-877b: it used to add "call team_inspect again", and a lead that had left its team (QA49) told the user
 * to wait until its team permissions came back. A session that left its team gets `teamExitedMessage`.
 */
export const NO_TEAM_SCOPE_MESSAGE = 'This session is not in a team, so team tools do not work here. Retrying will not change that. Do not create or join a team to get one: answer the user and do what they ask yourself, in this session; use team_create or team_join only when the user explicitly asks for a new team.';
/** B-730: a Teams-spawned session whose scope file is gone (the daemon could not restore it). */
export const MISSING_TEAM_SCOPE_MESSAGE = 'This session\'s team scope is missing (the Very Happy daemon could not restore it), so team tools do not work here. Retrying will not help. Tell the user; the owner can restart this session from the team page to restore it. Do not create or join another team.';

/** The refusal for a session without a usable scope (B-877b: a session that left its team says so). */
export function noTeamScopeMessage(sessionId: string | undefined, home: string = configuration.happyHomeDir): string {
    const marker = readTeamExitMarker(home, sessionId);
    if (marker) return teamExitedMessage(marker);
    return process.env.VH_TEAM_SCOPE_FILE ? MISSING_TEAM_SCOPE_MESSAGE : NO_TEAM_SCOPE_MESSAGE;
}

const initializationLocks = new Map<string, Promise<unknown>>();
async function serializeInitialization<T>(path: string, work: () => Promise<T>): Promise<T> {
    const previous = initializationLocks.get(path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    initializationLocks.set(path, next);
    try { return await next; }
    finally { if (initializationLocks.get(path) === next) initializationLocks.delete(path); }
}

/**
 * B-726 (`specs/2026-10-team-project.md`): a new team belongs to a project by
 * default — the creating session's own project when it has one, otherwise a
 * new same-name project at this session's folder. An older server strips
 * `project` and creates the team exactly as before.
 */
export function teamCreateBody(input: { name: string; requestId: string; projectId?: string; noProject?: boolean; transfer?: true }, machineId: string, sessionId: string, directory: string | undefined) {
    // B-730: `sessionId` lets the server refuse a session that already belongs to another live team.
    const body = { name: input.name, machineId, requestId: input.requestId, sessionId, ...(input.transfer ? { transfer: true as const } : {}) };
    if (input.noProject) return body;
    if (input.projectId) return { ...body, project: { projectId: input.projectId } };
    return { ...body, project: { inheritFromSessionId: sessionId, ...(directory ? { directory } : {}) } };
}

const gitCommonDir = async (directory: string) =>
    (await promisify(execFile)('git', ['-C', directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 10_000 })).stdout.trim();

/**
 * B-755: the folder a same-name project gets when this session creates a
 * team. A session inside a team worktree (`<happy home>/teams/worktrees/<id>`)
 * names the repository's main checkout instead (`--git-common-dir`'s parent),
 * keeping a subfolder's place. When Git cannot tell, the raw path goes to the
 * server, which follows the worktree's spawn operation or leaves the project
 * without a folder — never the worktree itself.
 */
export async function teamProjectDirectory(path: string | undefined, commonDir: (directory: string) => Promise<string> = gitCommonDir): Promise<string | undefined> {
    if (!path || !isInsideTeamWorktree(path)) return path;
    const common = await commonDir(path).catch(() => null);
    // A bare repository's common dir is not `.git` and has no checkout to point at.
    return common && basename(common) === '.git' ? rebaseTeamWorktreePath(path, dirname(common)) : path;
}

export function createTeamsClient(sessionId?: string) {
    const scopePath = () => teamScopePath(sessionId ?? process.env.HAPPY_SESSION_ID);
    return {
        async initialize(input: { teamId?: string; name: string; machineId?: string; botId?: string; requestId: string; projectId?: string; noProject?: boolean; transfer?: true }, options?: { resumeAdoption?: boolean; expectedTeamId?: string; onTeamResolved?: (teamId: string) => Promise<void> }) {
            const path = scopePath();
            return serializeInitialization(path, async () => {
                const priorScope = await readTeamScope(path);
                if (priorScope && !options?.resumeAdoption) throw new Error('This session already has a team scope; use scoped team tools');
                // A worker with a missing scope must never fall back to account authority.
                if (process.env.VH_TEAM_SCOPE_FILE) throw new Error('Assigned team scope is missing or already managed; ask the owner to restore it');
                const sid = sessionId ?? process.env.HAPPY_SESSION_ID;
                if (!sid) throw new Error('A managed session identity is required');
                const machineId = (await readSettings()).machineId;
                if (!machineId) throw new TeamConnectionPreflightError('Connect this machine to Very Happy before joining a team');
                if (input.machineId && input.machineId !== machineId) throw new TeamConnectionPreflightError('Teams must use this session’s local machine');
                const persisted = readPersistedSessions()[sid];
                if (!persisted || persisted.metadata.machineId !== machineId) throw new TeamConnectionPreflightError('Team identity must be a persisted session on this machine');
                const credentials = await readCredentialsForConfiguredRelay();
                if (!credentials) throw new TeamConnectionPreflightError('Sign in to Very Happy before creating or joining a team');
                if (priorScope && !options?.expectedTeamId) throw new Error('This session already belongs to another team scope');
                let teamId = input.teamId ?? options?.expectedTeamId;
                if (!teamId) {
                    const created = await teamRequest('/v1/teams', 'POST', credentials.token, false, teamCreateBody(input, machineId, sid, await teamProjectDirectory(persisted.metadata.path)));
                    teamId = created.team.id;
                } else {
                    const existing = await teamRequest(`/v1/teams/${encodeURIComponent(teamId)}`, 'GET', credentials.token, false);
                    if (existing.team?.machineId !== machineId) throw new TeamConnectionPreflightError('Team belongs to another machine');
                }
                if (options?.onTeamResolved) await options.onTeamResolved(teamId!);
                if (priorScope) {
                    if (priorScope.teamId !== teamId || priorScope.taskId) throw new Error('This session already belongs to another team scope');
                    const inspected = await teamRequest(`/v1/teams/${encodeURIComponent(teamId!)}/agent`, 'GET', priorScope.scopeToken, true);
                    const bot = inspected.team?.bots?.find((candidate: any) => candidate.id === priorScope.botId);
                    if (!bot?.root || bot.managed || bot.sessionId !== sid) throw new Error('Existing scope is not this session’s root identity');
                    return { team: inspected.team, botId: priorScope.botId };
                }
                const result = await teamRequest(`/v1/teams/${encodeURIComponent(teamId!)}/actions`, 'POST', credentials.token, false,
                    { requestId: input.requestId, action: { type: 'join', name: input.name, sessionId: sid, ...(input.botId ? { botId: input.botId } : {}), ...(input.transfer ? { transfer: true as const } : {}) } });
                if (!result.credential?.token || !result.credential?.botId) throw new Error('Team join did not issue a credential');
                await writeTeamScope(path, { serverUrl: configuration.serverUrl, teamId: teamId!, botId: result.credential.botId, scopeToken: result.credential.token });
                return { team: result.team, botId: result.credential.botId };
            });
        },
        async inspect() {
            const scope = await readTeamScope(scopePath());
            if (!scope) throw new Error(noTeamScopeMessage(sessionId ?? process.env.HAPPY_SESSION_ID));
            const { credential: _credential, ...safe } = await teamRequest(`/v1/teams/${encodeURIComponent(scope.teamId)}/agent`, 'GET', scope.scopeToken, true);
            // B-881: the caller's bot, so the compact view lists the messages it sent or received.
            return { ...safe, botId: scope.botId };
        },
        async action(action: Record<string, unknown>, requestId: string = randomUUID()) {
            const scope = await readTeamScope(scopePath());
            if (!scope) throw new Error(noTeamScopeMessage(sessionId ?? process.env.HAPPY_SESSION_ID));
            const result = await teamRequest(`/v1/teams/${encodeURIComponent(scope.teamId)}/agent`, 'POST', scope.scopeToken, true, { requestId, action });
            // Scope issuance is never part of a model-facing response.
            const { credential: _credential, ...safe } = result;
            return safe;
        },
    };
}
