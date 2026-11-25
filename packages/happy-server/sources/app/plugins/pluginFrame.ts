import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '@/storage/db';
import { pluginHostConfig, pluginOrigin } from './pluginConfig';
import { assertPluginsEnabled, loadInstall } from './pluginStore';
import { PluginError, requirePlugin, requireUsable, type InstallRow } from './pluginRules';
import type { PluginManifest } from '@slopus/happy-wire';

/**
 * B-974 §4.2 panel entry. Both credentials are stateless HMAC tokens (any replica verifies them):
 *
 *  - frame ticket — one use (claimed in `RepeatKey`), 60 s, bound to install + panel + account + the
 *    Web login session that asked for it;
 *  - frame session — the `__Host-vhp` cookie on the install's own origin, 12 h, renewed while used,
 *    bound to install + account + login session + the install's `frameEpoch`. Disable, `panel` revoke
 *    and remove bump the epoch; signing out revokes the login session; either voids it on the next request.
 */

export const FRAME_COOKIE = '__Host-vhp';
export const TICKET_TTL_MS = 60_000;
export const FRAME_SESSION_TTL_MS = 12 * 3600_000;
const RENEW_BELOW_MS = 6 * 3600_000;

function signingKey(): Buffer {
    const master = process.env.HANDY_MASTER_SECRET;
    if (!master) throw new PluginError('panels_unavailable', 503);
    return createHmac('sha256', master).update('vh-plugin-frame/v1').digest();
}

function b64url(data: Buffer | string): string {
    return Buffer.from(data).toString('base64url');
}

export function signToken(kind: 'ticket' | 'frame', payload: Record<string, unknown>, key: Buffer = signingKey()): string {
    const body = b64url(JSON.stringify({ k: kind, ...payload }));
    return `${body}.${b64url(createHmac('sha256', key).update(body).digest())}`;
}

/** The payload of a valid token of `kind`, or null (bad shape, bad signature, wrong kind, expired). */
export function verifyToken<T extends { exp: number }>(kind: 'ticket' | 'frame', token: string | undefined, now = Date.now(), key: Buffer = signingKey()): (T & { k: string }) | null {
    if (!token || token.length > 2048) return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
    const body = token.slice(0, dot);
    const sig = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = createHmac('sha256', key).update(body).digest();
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
    let payload: (T & { k: string }) | null = null;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    if (!payload || payload.k !== kind || typeof payload.exp !== 'number' || payload.exp <= now) return null;
    return payload;
}

export interface TicketPayload { exp: number; n: string; i: string; a: string; p: string; l: string; path: string; o: string | null }
/** `p`: the panel entered — one origin per install, so the cookie names which panel's upstream the daemon uses. */
export interface FramePayload { exp: number; i: string; a: string; l: string; e: number; p: string; o: string | null }

/** A path the entry redirect may go to: same-origin absolute path only. */
export function safeEntryPath(path: string | undefined, fallback: string): string {
    const candidate = path ?? fallback;
    if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\') || /[\u0000-\u001f\u007f]/.test(candidate) || candidate.length > 2048) return fallback.startsWith('/') && !fallback.startsWith('//') ? fallback : '/';
    return candidate;
}

/** POST /v1/plugins/installs/:id/frame-ticket (signed-in person; the route checks that). */
export async function issueFrameTicket(accountId: string, installId: string, input: { panelId: string; path?: string }, ctx: { loginSessionId: string; webOrigin: string | null }, now = Date.now()): Promise<{ ticket: string; url: string; origin: string; expiresAt: number }> {
    assertPluginsEnabled(accountId);
    const host = pluginHostConfig();
    requirePlugin(host, 'panels_unavailable', 404);
    const install = await loadInstall(db, accountId, installId);
    requireUsable(install, 'panel');
    const panel = ((install.manifest as PluginManifest | null)?.panels ?? []).find(p => p.id === input.panelId);
    requirePlugin(panel, 'not_found', 404);
    const path = safeEntryPath(input.path, panel.entry ?? '/');
    const exp = now + TICKET_TTL_MS;
    const ticket = signToken('ticket', { exp, n: b64url(randomBytes(16)), i: install.id, a: accountId, p: panel.id, l: ctx.loginSessionId, path, o: ctx.webOrigin } satisfies TicketPayload);
    const origin = pluginOrigin(install.originLabel, host);
    return { ticket, url: `${origin}/__vh/enter?t=${encodeURIComponent(ticket)}`, origin, expiresAt: exp };
}

/** One use: the nonce is claimed in RepeatKey (PK), so a replay — on any replica — fails. */
export async function claimTicketNonce(nonce: string, exp: number): Promise<boolean> {
    try {
        await db.repeatKey.create({ data: { key: `vh-plugin-ticket:${nonce}`, value: '1', expiresAt: new Date(exp + 60_000) } });
        return true;
    } catch {
        return false;
    }
}

export async function loginSessionAlive(id: string, accountId: string, now = Date.now()): Promise<boolean> {
    const row = await db.accountLoginSession.findUnique({ where: { id }, select: { accountId: true, revokedAt: true, expiresAt: true } });
    return !!row && row.accountId === accountId && row.revokedAt === null && row.expiresAt.getTime() > now;
}

export function frameSessionFor(install: Pick<InstallRow, 'id' | 'accountId' | 'frameEpoch'>, panelId: string, loginSessionId: string, webOrigin: string | null, now = Date.now()): { token: string; exp: number } {
    const exp = now + FRAME_SESSION_TTL_MS;
    return { token: signToken('frame', { exp, i: install.id, a: install.accountId, l: loginSessionId, e: install.frameEpoch, p: panelId, o: webOrigin } satisfies FramePayload), exp };
}

export function shouldRenew(payload: { exp: number }, now = Date.now()): boolean {
    return payload.exp - now < RENEW_BELOW_MS;
}

/** Same registrable site (last two labels) → Lax works inside the iframe; otherwise None + Partitioned (CHIPS). */
export function sameSite(webOrigin: string | null, pluginHost: string): boolean {
    if (!webOrigin) return true;
    let host: string;
    try { host = new URL(webOrigin).hostname; } catch { return true; }
    const site = (h: string) => h.split(':')[0].split('.').slice(-2).join('.');
    return site(host) === site(pluginHost);
}

export function frameCookie(token: string, crossSite: boolean): string {
    return `${FRAME_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(FRAME_SESSION_TTL_MS / 1000)}; Secure; HttpOnly; ${crossSite ? 'SameSite=None; Partitioned' : 'SameSite=Lax'}`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return undefined;
}
