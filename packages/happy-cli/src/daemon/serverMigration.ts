/**
 * B-635 — the relay moved; follow it without anyone typing a command.
 *
 * The OLD relay emits `server-migrate { url, webappUrl, handoff }` to every
 * targeted machine socket (B-627). This module turns that into a local state
 * change: a token from the NEW relay (the handoff is signed by the old relay
 * and verified by the new one), credentials rewritten for that relay, and
 * `settings.serverUrl` / `webappUrl` pointed at it. The caller (daemon/run.ts)
 * then hands over to a fresh `daemon start`, exactly like a CLI update, so the
 * next process reads the new settings. Session wrappers already running stay
 * on the old relay until they end; new ones go to the new relay.
 *
 * Deliberately refused (loudly logged) rather than half-done:
 *  - HAPPY_SERVER_URL set in the environment: settings would be ignored and
 *    the daemon would bounce between relays forever.
 *  - A notice for the relay we are already on (idempotent re-sends).
 *  - Anything but https (loopback http is fine for development).
 */
import { ServerMigrateNoticeSchema, type ServerMigrateNotice } from '@slopus/happy-wire';
import type { Credentials } from '@/persistence';
import { sameRelay } from '@/ui/authRelay';

export interface ServerMigrationDeps {
    configuredServerUrl: string;
    env: NodeJS.ProcessEnv;
    clientId: string;
    fetch: typeof fetch;
    readCredentials: () => Promise<Credentials | null>;
    rewriteCredentials: (credentials: Credentials, next: { token: string; authServerUrl: string }) => Promise<void>;
    /** persistence.updateSettings; typed loosely because Settings is private to that module. */
    updateSettings: (updater: (current: any) => any) => Promise<unknown>;
    log: (message: string) => void;
}

export type ServerMigrationOutcome =
    | { action: 'ignored'; reason: string }
    | { action: 'refused'; reason: string }
    | { action: 'moved'; serverUrl: string; webappUrl: string };

export function isAcceptableRelayUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
        return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback);
    } catch {
        return false;
    }
}

export async function applyServerMigration(raw: unknown, deps: ServerMigrationDeps): Promise<ServerMigrationOutcome> {
    const parsed = ServerMigrateNoticeSchema.safeParse(raw);
    if (!parsed.success) return { action: 'ignored', reason: 'malformed notice' };
    const notice: ServerMigrateNotice = parsed.data;
    if (sameRelay(notice.url, deps.configuredServerUrl)) return { action: 'ignored', reason: 'already on that relay' };
    if (!isAcceptableRelayUrl(notice.url) || !isAcceptableRelayUrl(notice.webappUrl)) {
        return refuse(deps, `relay URL must be https: ${notice.url}`);
    }
    if (deps.env.HAPPY_SERVER_URL?.trim()) {
        return refuse(deps, `HAPPY_SERVER_URL is set in this daemon's environment; unset it (or point it at ${notice.url}) and restart the daemon`);
    }
    const credentials = await deps.readCredentials();
    if (!credentials) return refuse(deps, 'no credentials on disk');

    let token: string;
    try {
        const response = await deps.fetch(`${notice.url}/v1/auth/migrate/complete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'X-Happy-Client': deps.clientId },
            body: JSON.stringify({ handoff: notice.handoff }),
        });
        if (!response.ok) return refuse(deps, `${notice.url} refused the handoff (HTTP ${response.status})`);
        const body = await response.json() as { kind?: unknown; token?: unknown };
        if (body.kind !== 'daemon' || typeof body.token !== 'string' || !body.token) return refuse(deps, `${notice.url} answered without a daemon token`);
        token = body.token;
    } catch (error) {
        return refuse(deps, `${notice.url} unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Settings first, credentials second: a crash in between leaves settings
    // pointing at the new relay with old-relay credentials, which the next
    // start reports as a relay mismatch — visible, and fixed by `auth login`.
    await deps.updateSettings((current) => ({ ...current, serverUrl: notice.url, webappUrl: notice.webappUrl }));
    await deps.rewriteCredentials(credentials, { token, authServerUrl: notice.url });
    deps.log(`[RELAY MOVE] Moved this machine from ${deps.configuredServerUrl} to ${notice.url}; handing over to a new daemon`);
    return { action: 'moved', serverUrl: notice.url, webappUrl: notice.webappUrl };
}

function refuse(deps: ServerMigrationDeps, reason: string): ServerMigrationOutcome {
    deps.log(`[RELAY MOVE] Not moving this machine: ${reason}`);
    return { action: 'refused', reason };
}
