/**
 * Who is behind a request: a person signed in to the Web, or a machine.
 *
 * `human`: the bearer token was issued for a login session (`createLoginToken`).
 * Every current Web sign-in path issues one: email code, Google, OIDC,
 * password, `login/refresh`, and the Web side of a relay migration.
 *
 * `machine`: any other token. That covers terminal pairing (CLI / daemon), the
 * daemon side of a relay migration, legacy `/v1/auth` public-key auth (old CLI
 * `access.key`), and account-device pairing (the `happy-agent` link). It also
 * covers tokens issued before login sessions existed: they stay valid for
 * ordinary use, but a person holding one is asked to sign in again before an
 * owner-only action (`owner_login_required`).
 *
 * The check reads only `request.authLoginSessionId`, which the authenticate
 * decorator sets after `verifyToken`. `verifyToken` already refused a revoked or
 * expired login session, so a present id is a live one.
 *
 * Out of scope on purpose: a holder of the account master key (legacy
 * `access.key`, `agent.key`) can sign in as the owner anyway, so it is the
 * owner.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

export type RequestTokenKind = 'human' | 'machine';

export const OWNER_LOGIN_REQUIRED = 'owner_login_required';

export function requestTokenKind(request: Pick<FastifyRequest, 'authLoginSessionId'>): RequestTokenKind {
    return typeof request.authLoginSessionId === 'string' && request.authLoginSessionId.length > 0 ? 'human' : 'machine';
}

/**
 * Guard for routes that act as the owner (board choices, loosening safety settings).
 * Returns true when the request may continue; otherwise it has sent
 * `403 { error: 'owner_login_required' }`, and the caller returns that reply.
 */
export function requireHumanOwner(request: Pick<FastifyRequest, 'authLoginSessionId'>, reply: FastifyReply): boolean {
    if (requestTokenKind(request) === 'human') return true;
    void reply.code(403).send({ error: OWNER_LOGIN_REQUIRED });
    return false;
}
