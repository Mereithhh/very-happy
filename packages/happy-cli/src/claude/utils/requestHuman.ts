/**
 * B-510 `request_human`: an agent that needs a person (captcha, 2FA, QR scan,
 * OAuth consent, a judgement call) says so, optionally pointing at one of this
 * machine's web panels. Spec: specs/2026-09-machine-web-panels.md §4.
 *
 *  1. the task board shows `attention: blocked` + the reason (report_progress path);
 *  2. a push-event `attention` whose click target is the panel deep link when
 *     the panel is declared on this machine, else the session;
 *  3. the same reason within 60 s only refreshes the board — no second push.
 *
 * B-766: on a server with the briefing board, (2)+(3) become one `blocked`
 * item instead (`postBlocked`): the server dedupes it by a key derived from the
 * reason and pushes once. (1) stays for older Web clients. A server without
 * the board (or a failed post) keeps the push path above.
 */
import { normalizeWebPanels, webPanelPath } from '@/webPanels/webPanels';

export const REQUEST_HUMAN_TOOL_NAME = 'request_human';
export const REQUEST_HUMAN_REASON_MAX = 200;
export const REQUEST_HUMAN_DEDUPE_MS = 60_000;

export const REQUEST_HUMAN_TOOL_DESCRIPTION =
    'Ask the user to step in when you cannot continue on your own: a captcha, 2FA code, QR scan, OAuth consent page, or a decision only they can make. '
    + 'Sends a push notification and marks the task board as blocked. Give a short reason (no secrets; the server can read it). '
    + 'If this machine declares a web panel showing what you are working in (e.g. a remote desktop or browser dashboard), pass its id as `panel` so the notification opens it. '
    + 'Afterwards, poll for your own completion condition (the page changed, the element disappeared) instead of waiting for a reply.';

export interface RequestHumanDeps {
    sessionId: string;
    machineId: () => string | null | undefined;
    /** raw `webPanels` from this machine's settings.json */
    readPanels: () => Promise<unknown>;
    reportBlocked: (reason: string) => Promise<unknown>;
    sendAttention: (input: { sessionId: string; reason: string; url: string }) => Promise<{ sent: boolean; kind?: string; error?: string }>;
    /** B-766: post the ask as a briefing board `blocked` item; false = no board, use the push path. `panel` is a declared panel id. */
    postBlocked?: (reason: string, panel?: string) => Promise<boolean>;
    now?: () => number;
}

export interface RequestHumanResult {
    notified: boolean;
    deduped?: boolean;
    /** B-766: posted to the briefing board; the server sends the notification. */
    board?: boolean;
    url?: string;
    /** set when `panel` was given but this machine does not declare it */
    unknownPanel?: string;
    error?: string;
}

export function createRequestHuman(deps: RequestHumanDeps) {
    const now = deps.now ?? Date.now;
    let last: { reason: string; at: number } | null = null;
    return async (rawReason: string, panel?: string): Promise<RequestHumanResult> => {
        const reason = rawReason.replace(/\s+/g, ' ').trim().slice(0, REQUEST_HUMAN_REASON_MAX);
        if (!reason) return { notified: false, error: 'reason must be a non-empty string' };
        await deps.reportBlocked(reason);
        let url = `/session/${encodeURIComponent(deps.sessionId)}`;
        let unknownPanel: string | undefined;
        if (panel) {
            const machineId = deps.machineId();
            const { panels } = normalizeWebPanels(await deps.readPanels().catch(() => undefined));
            if (machineId && panels.some((p) => p.id === panel)) url = webPanelPath(machineId, panel);
            else unknownPanel = panel;
        }
        if (deps.postBlocked && await deps.postBlocked(reason, unknownPanel ? undefined : panel).catch(() => false)) {
            return { notified: true, board: true, ...(unknownPanel ? { unknownPanel } : {}) };
        }
        const at = now();
        if (last && last.reason === reason && at - last.at < REQUEST_HUMAN_DEDUPE_MS) {
            return { notified: true, deduped: true };
        }
        const sent = await deps.sendAttention({ sessionId: deps.sessionId, reason, url });
        if (sent.sent) last = { reason, at };
        return { notified: sent.sent, url, ...(unknownPanel ? { unknownPanel } : {}), ...(sent.error ? { error: sent.error } : {}) };
    };
}

export function requestHumanResultText(r: RequestHumanResult): string {
    if (r.board) {
        const panelNote = r.unknownPanel ? ` (panel "${r.unknownPanel}" is not declared on this machine, so it is not linked)` : '';
        return `Posted to the user's briefing board as blocked; the server notifies them once (asking again with the same reason only refreshes it)${panelNote}. This does not mean they have seen it. Poll your own completion condition (URL changed, element gone) instead of waiting for a reply.`;
    }
    if (r.deduped) return 'Already asked for this in the last minute; the board still shows it. Keep polling your completion condition.';
    if (!r.notified) return `Could not notify the user: ${r.error ?? 'unknown error'}. The task board is marked blocked.`;
    const panelNote = r.unknownPanel ? ` (panel "${r.unknownPanel}" is not declared on this machine, so the notification opens the session instead)` : '';
    return `Notified the user${panelNote}. This does not mean they have seen it. Poll your own completion condition (URL changed, element gone) instead of waiting for a reply.`;
}
