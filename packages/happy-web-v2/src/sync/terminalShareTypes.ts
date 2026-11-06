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

// ---- B-900: project terminals → "can operate" in one go (owner)

export type TerminalBatchRef = { machineId: string; terminalId: string; title?: string };
export const TerminalBatchResultSchema = z.object({
    machineId: z.string(),
    terminalId: z.string(),
    outcome: z.string().transform((v): 'created' | 'upgraded' | 'skipped' | 'failed' => (v === 'created' || v === 'upgraded' || v === 'skipped' ? v : 'failed')),
    code: z.string().optional(),
    grant: TerminalGrantViewSchema.optional().catch(undefined),
});
export type TerminalBatchResult = z.infer<typeof TerminalBatchResultSchema>;

/** One of the project's terminals as the owner sees it, with this person's current direct grant. */
export type OperatePlanItem = {
    machineId: string;
    terminalId: string;
    title: string;
    machineName: string;
    /** This person's live direct grant on it: operator / operator not accepted yet / view only / none. */
    current: 'operator' | 'operatorPending' | 'viewer' | 'none';
    /** What the batch does: nothing (already can operate), raise view only, or a new grant. */
    action: 'skip' | 'upgrade' | 'create';
};
export type OperatePlan = {
    items: OperatePlanItem[];
    /** The terminals the batch sends (skips excluded) — exactly the list the owner confirms. */
    send: TerminalBatchRef[];
    /** Distinct machine names of the terminals sent (the confirmation names them when > 1). */
    machines: string[];
    /** This person can operate some project terminals but not these (B-900 §5 hint); empty otherwise. */
    gap: OperatePlanItem[];
};

/**
 * B-900: what "give every terminal in the project can-operate" would do for one person, from the project's
 * terminals RIGHT NOW and my live grants. Only these terminals — never a project tier. Pure.
 */
export function planProjectOperate(terminals: ReadonlyArray<{ id: string; machineId: string; machineName: string; title: string }>, grants: ReadonlyArray<TerminalGrantView>, granteeId: string, now: number): OperatePlan {
    const mine = new Map<string, TerminalGrantView>();
    for (const g of grants) {
        if (g.grantee.id !== granteeId || g.status === 'revoked' || g.expiresAt <= now) continue;
        mine.set(`${g.machineId}:${g.terminalId}`, g);
    }
    const items: OperatePlanItem[] = terminals.map((tm) => {
        const g = mine.get(`${tm.machineId}:${tm.id}`);
        const current: OperatePlanItem['current'] = !g ? 'none' : g.role === 'operator' ? (g.status === 'active' ? 'operator' : 'operatorPending') : 'viewer';
        const action: OperatePlanItem['action'] = current === 'operator' || current === 'operatorPending' ? 'skip' : current === 'viewer' ? 'upgrade' : 'create';
        return { machineId: tm.machineId, terminalId: tm.id, title: tm.title, machineName: tm.machineName, current, action };
    });
    const sent = items.filter((i) => i.action !== 'skip');
    const machines = [...new Set(sent.map((i) => i.machineName).filter(Boolean))];
    const operates = items.some((i) => i.action === 'skip');
    return { items, send: sent.map((i) => ({ machineId: i.machineId, terminalId: i.terminalId, title: i.title })), machines, gap: operates ? sent : [] };
}

/** The terminals of `plan` the person has ANY direct grant on (what "revoke all terminal access" ends). Pure. */
export function directlyGranted(plan: OperatePlan): TerminalBatchRef[] {
    return plan.items.filter((i) => i.current !== 'none').map((i) => ({ machineId: i.machineId, terminalId: i.terminalId }));
}

/** Failed refs of a batch result, to retry exactly those. Pure. */
export function failedRefs(results: ReadonlyArray<TerminalBatchResult>, sent: ReadonlyArray<TerminalBatchRef>): TerminalBatchRef[] {
    const failed = new Set(results.filter((r) => r.outcome === 'failed').map((r) => `${r.machineId}:${r.terminalId}`));
    return sent.filter((r) => failed.has(`${r.machineId}:${r.terminalId}`));
}
