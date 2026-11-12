import type { FastifyRequest } from 'fastify';
import { businessAuditEnabled, publishAudit } from '@/app/audit/producer';
import { requestAuditContext } from '@/app/audit/requestAudit';
import { requestTokenKind } from '@/app/auth/tokenKind';
import { log } from '@/utils/log';

/**
 * B-933: who archived / unarchived a session. Incident B-932: a long-lived
 * session was archived and nothing on the server said by whom — the route
 * recorded no caller and container logs had rotated away.
 *
 * One record per archive / unarchive request (also 404s), written to
 *  - the container log (always): `module: 'session-archive-audit'`. The log
 *    sanitizer pseudonymizes `sessionId` / `userId` (`stableLogRef`); find a
 *    known session with `sha256("sessionid\0<id>")[:16]`, see docs/operations.md;
 *  - the business audit sink (when configured): kind `session.archived` /
 *    `session.unarchived` with the raw ids and the request context.
 *
 * Fields: token kind (`human` = browser login, `machine` = CLI / daemon /
 * access key, via `requestTokenKind`), `X-Happy-Client`, the caller-declared
 * `X-Happy-Archive-Source` (`team-cleanup`, `gc`, `main-agent`, …; absent =
 * not declared, e.g. the Web or an old CLI), a user-agent family and the time.
 * Never the token or other headers.
 */
export type SessionArchiveOperation = 'archive' | 'unarchive';

const SOURCE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const CLIENT_RE = /^[A-Za-z0-9][A-Za-z0-9._\/:+-]{0,63}$/;

function header(request: Pick<FastifyRequest, 'headers'>, name: string): string | undefined {
    const raw = request.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `X-Happy-Archive-Source`, bounded; `invalid` when present but malformed. */
export function archiveSourceHeader(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    return SOURCE_RE.test(raw) ? raw : 'invalid';
}

/** `X-Happy-Client`, bounded; `invalid` when present but malformed. */
export function happyClientHeader(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    return CLIENT_RE.test(raw) ? raw : 'invalid';
}

const BROWSERS: Array<[RegExp, string]> = [
    [/\bEdg\/(\d+)/, 'edge'],
    [/\bFirefox\/(\d+)/, 'firefox'],
    [/\bChrome\/(\d+)/, 'chrome'],
    [/\bVersion\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//, 'safari'],
];
const PLATFORMS: Array<[RegExp, string]> = [
    [/iPhone|iPad|iPod/, 'ios'],
    [/Android/, 'android'],
    [/Mac OS X|Macintosh/, 'macos'],
    [/Windows/, 'windows'],
    [/Linux/, 'linux'],
];
const TOOLS = /^(axios|node|undici|curl|python-requests|Go-http-client|okhttp)\/(\d+)/i;

/**
 * A short, non-identifying user-agent family: `chrome/131 macos`,
 * `safari/18 ios`, `axios/1`, `none`, `other`. Never the raw string.
 */
export function userAgentFamily(raw: string | undefined): string {
    if (!raw) return 'none';
    const tool = TOOLS.exec(raw);
    if (tool) return `${tool[1].toLowerCase()}/${tool[2]}`;
    if (/^node$/i.test(raw.trim())) return 'node';
    const platform = PLATFORMS.find(([re]) => re.test(raw))?.[1];
    for (const [re, name] of BROWSERS) {
        const match = re.exec(raw);
        if (match) return platform ? `${name}/${match[1]} ${platform}` : `${name}/${match[1]}`;
    }
    return 'other';
}

export function sessionArchiveAuditRecord(
    request: Pick<FastifyRequest, 'headers' | 'authLoginSessionId'>,
    input: { operation: SessionArchiveOperation; sessionId: string; userId: string; status: number; alreadyArchived?: boolean; now?: number },
) {
    return {
        module: 'session-archive-audit',
        operation: input.operation,
        sessionId: input.sessionId,
        userId: input.userId,
        status: input.status,
        alreadyArchived: input.alreadyArchived,
        tokenKind: requestTokenKind(request),
        client: happyClientHeader(header(request, 'x-happy-client')),
        source: archiveSourceHeader(header(request, 'x-happy-archive-source')),
        uaFamily: userAgentFamily(header(request, 'user-agent')),
        atMs: input.now ?? Date.now(),
    };
}

/** Write the audit record (log line + business audit). Never throws. */
export function auditSessionArchive(
    request: FastifyRequest,
    input: { operation: SessionArchiveOperation; sessionId: string; userId: string; status: number; alreadyArchived?: boolean },
): void {
    try {
        const record = sessionArchiveAuditRecord(request, input);
        log(record, `session ${input.operation} audit`);
        if (businessAuditEnabled()) {
            const { module: _module, sessionId, userId, ...payload } = record;
            publishAudit({
                ...requestAuditContext(request),
                kind: input.operation === 'archive' ? 'session.archived' : 'session.unarchived',
                accountId: userId,
                sessionId,
                payload,
            });
        }
    } catch {
        // Auditing must never fail the archive itself.
    }
}
