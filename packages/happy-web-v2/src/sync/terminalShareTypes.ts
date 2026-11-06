/**
 * B-878 terminal sharing — wire shapes (spec specs/2026-11-share-terminals-and-projects.md §7).
 * Parsed with safeParse everywhere a socket event arrives, so a newer server
 * adding fields never breaks this client, and an old client ignores events it
 * has no listener for.
 */
import { z } from 'zod';

export type TerminalShareRole = 'viewer' | 'operator';
export type TerminalShareExpiry = 1 | 7 | 30;
/** Lead 11-03: every terminal tier expires; no "forever". */
export const TERMINAL_SHARE_EXPIRY_CHOICES: TerminalShareExpiry[] = [1, 7, 30];
export function defaultTerminalShareExpiry(role: TerminalShareRole): TerminalShareExpiry {
    return role === 'operator' ? 1 : 7;
}

const roleSchema = z.string().transform((v): TerminalShareRole => (v === 'operator' ? 'operator' : 'viewer'));
const statusSchema = z.string().transform((v): 'pending' | 'active' | 'revoked' => (v === 'active' || v === 'revoked' ? v : 'pending'));
const PersonSchema = z.object({ id: z.string(), displayName: z.string(), username: z.string().nullable().optional() });

export const TerminalGrantViewSchema = z.object({
    id: z.string(),
    machineId: z.string(),
    terminalId: z.string(),
    role: roleSchema,
    status: statusSchema,
    title: z.string().nullable().optional(),
    createdAt: z.number(),
    acceptedAt: z.number().nullable().optional(),
    expiresAt: z.number(),
    grantee: PersonSchema,
});
export type TerminalGrantView = z.infer<typeof TerminalGrantViewSchema>;

export const IncomingTerminalShareSchema = z.object({
    id: z.string(),
    role: roleSchema,
    status: statusSchema,
    granteeKey: z.string(),
    title: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    alive: z.boolean().nullable().optional(),
    viewOnlySupported: z.boolean().nullable().optional(),
    machineId: z.string(),
    createdAt: z.number(),
    expiresAt: z.number(),
    owner: PersonSchema,
});
export type IncomingTerminalShare = z.infer<typeof IncomingTerminalShareSchema>;

export const TerminalShareEventSchema = z.object({
    id: z.string(),
    kind: z.string(),
    actorAccountId: z.string(),
    detail: z.record(z.string(), z.unknown()).optional().nullable(),
    at: z.number(),
});
export type TerminalShareEvent = z.infer<typeof TerminalShareEventSchema>;

// ---- socket events (grantee)
export const ShareTerminalOutputSchema = z.object({ grantId: z.string(), seq: z.number().optional(), data: z.string() });
export const ShareTerminalExitSchema = z.object({ grantId: z.string(), exitCode: z.number().optional(), reason: z.string().optional() });
export const ShareTerminalRevokedSchema = z.object({ grantId: z.string(), reason: z.string().optional() });
export const ShareTerminalGeometrySchema = z.object({ grantId: z.string(), cols: z.number().int().min(2).max(10_000), rows: z.number().int().min(2).max(10_000) });
// ---- socket events (both sides)
export const TerminalShareUpdatedSchema = z.object({ grantId: z.string() });
// ---- socket events (owner)
export const TerminalShareActivitySchema = z.object({
    grantId: z.string(),
    machineId: z.string(),
    terminalId: z.string(),
    granteeAccountId: z.string(),
    displayName: z.string(),
    role: z.string().nullable().optional(),
    watching: z.boolean(),
    at: z.number(),
});
export type TerminalShareActivity = z.infer<typeof TerminalShareActivitySchema>;

/** Stable broker error codes (server terminalSharePolicy.ts) plus the client-side ones. */
export type TerminalShareErrorCode =
    | 'not_shared'
    | 'share_method_denied'
    | 'terminal_gone'
    | 'cli_upgrade_required'
    | 'machine_unsupported'
    | 'machine_offline'
    | 'rpc_failed'
    | 'rate_limited'
    | 'bad_params'
    | 'server_too_old'
    | 'key_unavailable';

export class TerminalShareRpcError extends Error {
    constructor(readonly code: TerminalShareErrorCode | string) {
        super(`terminal-share: ${code}`);
    }
}

/** The broker's ack → result or error code. Pure. */
export function readTerminalShareAck(ack: unknown): { ok: true; result: string } | { ok: false; code: string } {
    if (!ack || typeof ack !== 'object') return { ok: false, code: 'rpc_failed' };
    const a = ack as { ok?: unknown; result?: unknown; error?: unknown };
    if (a.ok === true && typeof a.result === 'string') return { ok: true, result: a.result };
    if (a.ok === false && typeof a.error === 'string') return { ok: false, code: a.error };
    return { ok: false, code: 'rpc_failed' };
}

/** `downgraded` = still shared, one tier lower (the pane remounts view-only); every other reason ends access. Pure. */
export function revokeEndsAccess(reason: string | undefined): boolean {
    return reason !== 'downgraded';
}

/**
 * A view-only pane renders at the OWNER's width and scales to fit its box
 * (it never resizes the owner's pane). Returns the CSS scale (≤1: shrink only;
 * a wider box shows the pane at natural size). Pure.
 */
export function viewOnlyScale(paneWidthPx: number, boxWidthPx: number): number {
    if (!(paneWidthPx > 0) || !(boxWidthPx > 0)) return 1;
    return Math.min(1, boxWidthPx / paneWidthPx);
}

/**
 * B-899: run tasks one after another per key (a failing task never blocks the next). Keystrokes go
 * through this so a slow first seal (key fetch) cannot let a later keystroke overtake it. Pure.
 */
export function serialPerKey(): (key: string, task: () => Promise<void>) => Promise<void> {
    const chains = new Map<string, Promise<void>>();
    return (key, task) => {
        const next = (chains.get(key) ?? Promise.resolve()).then(task).catch(() => {});
        chains.set(key, next);
        void next.then(() => { if (chains.get(key) === next) chains.delete(key); });
        return next;
    };
}
