/**
 * B-927a: owner-only actions need a signed-in person (see tokenKind.ts), not a machine token.
 *
 * A machine token (CLI / daemon `access.key`) used to be treated as the owner on `/v1/teams/:id/actions`,
 * on the share routes and on project permission changes. This module is the one place that decides
 * what a machine may still do there and how strictly it is enforced.
 *
 * Switches (read on every call, so a restart with a new value is the whole rollback):
 *   OWNER_GUARD_MODE           enforce (default) | observe | off
 *   OWNER_GUARD_PROJECT_PERMS  observe (default) | enforce   (project permission loosening only;
 *                              never stricter than OWNER_GUARD_MODE)
 * `observe` never refuses: it logs who called (`kind` = token kind, `accountId` as the log's stable reference, `operation` = route),
 * never a token or a body value. (Key names matter: logSafety keeps only whitelisted string keys readable.)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ProjectDefaults, TeamAction } from '@slopus/happy-wire';
import { log, warn } from '@/utils/log';
import { OWNER_LOGIN_REQUIRED, requestTokenKind } from './tokenKind';

export type OwnerGuardMode = 'enforce' | 'observe' | 'off';
type Caller = Pick<FastifyRequest, 'authLoginSessionId'> & { userId?: string };

function parse(value: string | undefined, fallback: OwnerGuardMode): OwnerGuardMode {
    const v = value?.trim().toLowerCase();
    return v === 'enforce' || v === 'observe' || v === 'off' ? v : fallback;
}

export function ownerGuardMode(env: NodeJS.ProcessEnv = process.env): OwnerGuardMode {
    return parse(env.OWNER_GUARD_MODE, 'enforce');
}

let warnedProjectPerms: string | undefined;
/** Project permission loosening: observe unless the operator opts in; `off` / `observe` at the top level win. */
export function projectPermsGuardMode(env: NodeJS.ProcessEnv = process.env): OwnerGuardMode {
    const top = ownerGuardMode(env);
    if (top !== 'enforce') return top;
    const raw = env.OWNER_GUARD_PROJECT_PERMS?.trim().toLowerCase();
    if (!raw || raw === 'observe') return 'observe';
    if (raw === 'enforce') return 'enforce';
    // An unreadable value must not silently loosen the guard: treat it as enforce, like OWNER_GUARD_MODE does.
    if (warnedProjectPerms !== raw) { warnedProjectPerms = raw; warn({ module: 'owner-guard', mode: 'enforce', operation: 'config' }, 'OWNER_GUARD_PROJECT_PERMS has an unknown value; treating it as enforce'); }
    return 'enforce';
}

/**
 * Returns true when the caller may continue. For a machine token: `enforce` sends
 * `403 { error: 'owner_login_required' }` (the caller returns the reply), `observe` logs and continues.
 */
export function guardOwnerAction(request: Caller, reply: FastifyReply, route: string, mode: OwnerGuardMode = ownerGuardMode()): boolean {
    if (mode === 'off') return true;
    const kind = requestTokenKind(request);
    if (kind === 'human') return true;
    (mode === 'enforce' ? warn : log)({ module: 'owner-guard', mode, kind, operation: route, accountId: request.userId },
        `owner guard ${mode === 'enforce' ? 'refused' : 'observed'} a machine token on ${route}`);
    if (mode === 'observe') return true;
    void reply.code(403).send({ error: OWNER_LOGIN_REQUIRED });
    return false;
}

/** preHandler for routes that are owner-only for every body (sharing). */
export function humanOnly(route: string) {
    return async (request: any, reply: FastifyReply) => {
        if (!guardOwnerAction(request, reply, route)) return reply;
    };
}

/**
 * What a machine token may still send to `/v1/teams/:id/actions`. Everything else is the owner's: the
 * Lead and members act through `/agent` with their team token, and the Web signs in as a person.
 *  - daemon bookkeeping: claim / complete / fail-operation, session-event, message-delivered
 *  - join (a seat takeover by another session is refused in the store, see `machineJoinRefusal`)
 *  - `archive` that keeps the Lead session (leaving team mode)
 *  - set-permission-mode to `default` (tightening)
 */
export function machineMayAct(action: TeamAction): boolean {
    switch (action.type) {
        case 'claim-operation': case 'complete-operation': case 'fail-operation':
        case 'session-event': case 'message-delivered': case 'join':
            return true;
        case 'archive': return action.keepLeadSession === true;
        case 'set-permission-mode': return action.permissionMode === 'default';
        default: return false;
    }
}

export function guardTeamAction(request: Caller, reply: FastifyReply, action: TeamAction): boolean {
    if (requestTokenKind(request) === 'human' || machineMayAct(action)) return true;
    return guardOwnerAction(request, reply, `teams.actions.${action.type}`);
}

/** Creating a team with `launch` starts agents on a machine, so it is the owner's; a plain create stays open. */
export function guardTeamCreate(request: Caller, reply: FastifyReply, launch: unknown): boolean {
    return launch === undefined || launch === null || guardOwnerAction(request, reply, 'teams.create.launch');
}

/** Mode values a machine may set without a person: they never widen what an agent may do. */
const TIGHT_PERMISSION_MODES = new Set(['default', 'plan', 'read-only']);

/**
 * Loosening a project: any permission mode that is not a known tight one (unknown values count as loosening),
 * or a change to the folders agents start in.
 */
export function looseProjectChange(input: { defaults?: ProjectDefaults | null; folders?: unknown }): boolean {
    const mode = input.defaults?.permissionMode;
    if (typeof mode === 'string' && !TIGHT_PERMISSION_MODES.has(mode)) return true;
    return input.folders !== undefined;
}

/**
 * Creating a project in one request must not do what the owner-only calls refuse one by one:
 * non-empty `instructions` is the owner's like `PUT instructions` (always `OWNER_GUARD_MODE`);
 * `folders` / `defaults` follow `OWNER_GUARD_PROJECT_PERMS`.
 */
export function guardProjectCreate(request: Caller, reply: FastifyReply, input: { instructions?: string; defaults?: ProjectDefaults | null; folders?: unknown }): boolean {
    if (input.instructions && input.instructions.length > 0 && !guardOwnerAction(request, reply, 'projects.create.instructions')) return false;
    return guardProjectChange(request, reply, 'projects.create', input);
}

/**
 * Adding sessions to a project is never refused: `via` is client-supplied (a machine could claim `lineage`), and the legitimate
 * callers (issue dispatch `issue`, `spawn --project` `explicit`) are machine tokens. The instructions themselves are owner-only
 * on `PUT` and `POST /v1/projects`. This only leaves an observe line (when the guard is not `off`).
 */
export function observeProjectMembers(request: Caller, reply: FastifyReply): void {
    guardOwnerAction(request, reply, 'projects.members.add', ownerGuardMode() === 'off' ? 'off' : 'observe');
}

export function guardProjectChange(request: Caller, reply: FastifyReply, route: string, input: { defaults?: ProjectDefaults | null; folders?: unknown }): boolean {
    if (!looseProjectChange(input)) return true;
    return guardOwnerAction(request, reply, route, projectPermsGuardMode());
}

/**
 * A machine `join` naming a `botId` (root or member seat) from any session other than the one the seat is bound to is a
 * takeover; an unbound seat (`sessionId` null) counts. The same session re-attaching its own seat is untouched.
 * A join without `botId` (Web adopt, `team_join`) is not refused, including into a team that already has a root.
 */
export function machineJoinRefusal(action: TeamAction, bots: readonly { id: string; sessionId?: string | null; root?: boolean }[]): 'takeover' | null {
    if (action.type !== 'join' || action.botId === undefined) return null;
    const seat = bots.find(b => b.id === action.botId);
    return seat && seat.sessionId !== action.sessionId ? 'takeover' : null;
}
