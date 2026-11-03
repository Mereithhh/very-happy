/**
 * B-878 terminal sharing — the pure rules (spec
 * specs/2026-11-share-terminals-and-projects.md §3). No I/O here: the broker
 * (terminalShareBroker.ts) authorizes, re-keys and forwards; this file decides
 * what a grant may do and how each call is rewritten for the owner's daemon.
 *
 *  - viewer:   attach (view-only, never resizes the owner's pane) + history.
 *  - operator: attach + history + scroll + paste, input and resize events.
 *  - nobody:   open a new terminal, kill, list the machine, startupCommand,
 *              attachTmux — the grant names ONE terminal and that is all.
 */

export type TerminalShareRole = 'viewer' | 'operator';
export const TERMINAL_SHARE_ROLES: readonly TerminalShareRole[] = ['viewer', 'operator'];
/** Lead 11-03: every terminal tier expires — terminal output often echoes env / tokens. */
export const TERMINAL_SHARE_EXPIRY_DAYS = [1, 7, 30] as const;
export type TerminalShareExpiryDays = typeof TERMINAL_SHARE_EXPIRY_DAYS[number];
export const MAX_TERMINAL_GRANTS_PER_TERMINAL = 20;

export type TerminalShareErrorCode =
    | 'not_shared'
    | 'share_method_denied'
    | 'operator_requires_confirm'
    | 'bad_expiry'
    | 'terminal_gone'
    | 'cli_upgrade_required'
    | 'machine_unsupported'
    | 'machine_offline'
    | 'rpc_failed'
    | 'rate_limited'
    | 'bad_params';

export class TerminalShareError extends Error {
    constructor(readonly code: TerminalShareErrorCode) {
        super(code);
    }
}

export function isTerminalShareRole(value: unknown): value is TerminalShareRole {
    return value === 'viewer' || value === 'operator';
}

export function defaultExpiryDays(role: TerminalShareRole): TerminalShareExpiryDays {
    return role === 'operator' ? 1 : 7;
}

/**
 * The expiry a grant gets. Both tiers must expire (no "forever"); the operator
 * tier additionally needs the owner's explicit confirmation (B-867 §9).
 */
export function terminalShareExpiry(input: { role: TerminalShareRole; expiresInDays?: unknown; confirmOperator?: unknown }, now = Date.now()): Date {
    if (input.role === 'operator' && input.confirmOperator !== true) throw new TerminalShareError('operator_requires_confirm');
    const days = input.expiresInDays === undefined ? defaultExpiryDays(input.role) : input.expiresInDays;
    if (!(TERMINAL_SHARE_EXPIRY_DAYS as readonly unknown[]).includes(days)) throw new TerminalShareError('bad_expiry');
    return new Date(now + (days as number) * 24 * 60 * 60_000);
}

export const TERMINAL_SHARE_OPS = ['attach', 'history', 'scroll', 'paste'] as const;
export type TerminalShareOp = typeof TERMINAL_SHARE_OPS[number];

const OPS_BY_ROLE: Record<TerminalShareRole, readonly TerminalShareOp[]> = {
    // `scroll` moves the owner's tmux pane into copy-mode — a write to the
    // owner's screen, so a viewer never gets it. Its scrollback is the attach
    // snapshot (bounded scrollback) plus its own xterm buffer.
    viewer: ['attach', 'history'],
    operator: ['attach', 'history', 'scroll', 'paste'],
};

export type TerminalShareEvent = 'input' | 'resize' | 'close';

/** Grantee → owner-machine events. A viewer may only unsubscribe. */
export function allowTerminalShareEvent(role: TerminalShareRole, event: TerminalShareEvent): boolean {
    if (event === 'close') return true;
    return role === 'operator';
}

export type TerminalShareCallPlan = {
    method: 'open-terminal' | 'terminal-history' | 'terminal-scroll' | 'terminal-paste';
    params: Record<string, unknown>;
    auditKind?: string;
};

export type TerminalShareCallContext = {
    role: TerminalShareRole;
    terminalId: string;
    /** The owner's daemon honours `open-terminal.viewOnly` (daemonState.terminalViewOnly). */
    viewOnlyCapable: boolean;
    /** The pane's last reported size (daemonState.webTerminals), if any. */
    geometry: { cols: number; rows: number } | null;
};

function asObject(value: unknown): Record<string, unknown> {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new TerminalShareError('bad_params');
    return value as Record<string, unknown>;
}

function dimension(value: unknown, fallback: number): number {
    return Number.isSafeInteger(value) && (value as number) >= 2 && (value as number) <= 10_000 ? value as number : fallback;
}

/** Validate and rewrite one grantee call into the owner's machine RPC. Throws TerminalShareError. */
export function planTerminalShareCall(op: unknown, rawParams: unknown, ctx: TerminalShareCallContext): TerminalShareCallPlan {
    if (typeof op !== 'string' || !(TERMINAL_SHARE_OPS as readonly string[]).includes(op)) throw new TerminalShareError('share_method_denied');
    if (!OPS_BY_ROLE[ctx.role].includes(op as TerminalShareOp)) throw new TerminalShareError('share_method_denied');
    const params = asObject(rawParams);
    // The grant names the terminal; whatever id the grantee sends is ignored.
    const terminalId = ctx.terminalId;
    switch (op as TerminalShareOp) {
        case 'attach': {
            const out: Record<string, unknown> = { terminalId, encStream: true, attachOnly: true };
            if (ctx.role === 'viewer') {
                // Never the viewer's own size: a daemon without viewOnly would
                // resize the owner's pane to it (webTerminal.ts applyResize).
                if (!ctx.viewOnlyCapable) throw new TerminalShareError('cli_upgrade_required');
                out.viewOnly = true;
                out.cols = ctx.geometry?.cols ?? 80;
                out.rows = ctx.geometry?.rows ?? 24;
            } else {
                out.cols = dimension(params.cols, ctx.geometry?.cols ?? 80);
                out.rows = dimension(params.rows, ctx.geometry?.rows ?? 24);
            }
            if (Number.isSafeInteger(params.fromSeq) && (params.fromSeq as number) >= 0) out.fromSeq = params.fromSeq;
            if (params.resub === true) out.resub = true;
            return { method: 'open-terminal', params: out, auditKind: params.resub === true ? undefined : 'terminal.attach' };
        }
        case 'history': {
            if (typeof params.snapshotId !== 'string' || params.snapshotId.length > 128 || !Number.isSafeInteger(params.page)) throw new TerminalShareError('bad_params');
            return { method: 'terminal-history', params: { terminalId, snapshotId: params.snapshotId, page: params.page } };
        }
        case 'scroll': {
            if (!Number.isSafeInteger(params.lines) || Math.abs(params.lines as number) > 100_000) throw new TerminalShareError('bad_params');
            return { method: 'terminal-scroll', params: { terminalId, lines: params.lines } };
        }
        case 'paste': {
            if (typeof params.text !== 'string' || params.text.length > 256 * 1024) throw new TerminalShareError('bad_params');
            return { method: 'terminal-paste', params: { terminalId, text: params.text }, auditKind: 'terminal.paste' };
        }
    }
    throw new TerminalShareError('share_method_denied');
}

export type WebTerminalInfo = { title: string | null; cwd: string | null; cols: number | null; rows: number | null; projectId: string | null };

type DaemonStateShape = {
    startedAt?: unknown;
    webTerminals?: { updatedAt?: unknown; terminals?: unknown };
    terminalViewOnly?: { rpcAvailable?: unknown; detectedAt?: unknown };
};

/** This daemon run pushed the terminal list (same trust rule as the web: updatedAt >= startedAt). */
function trustedTerminals(state: unknown): unknown[] | null {
    const s = state as DaemonStateShape | null;
    const wt = s?.webTerminals;
    if (!wt || typeof wt.updatedAt !== 'number' || !Array.isArray(wt.terminals)) return null;
    if (typeof s?.startedAt === 'number' && wt.updatedAt < s.startedAt) return null;
    return wt.terminals;
}

/** One terminal of a decrypted daemonState, or null when the list does not hold it (or cannot be trusted). */
export function webTerminalInfo(state: unknown, terminalId: string): WebTerminalInfo | null {
    const list = trustedTerminals(state);
    if (!list) return null;
    const item = list.find((t) => !!t && typeof t === 'object' && (t as { id?: unknown }).id === terminalId) as Record<string, unknown> | undefined;
    if (!item) return null;
    const num = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 2 && (v as number) <= 10_000 ? v as number : null;
    const cols = num(item.paneCols); const rows = num(item.paneRows);
    return {
        title: typeof item.title === 'string' ? item.title.slice(0, 200) : null,
        cwd: typeof item.cwd === 'string' ? item.cwd : null,
        cols: cols !== null && rows !== null ? cols : null,
        rows: cols !== null && rows !== null ? rows : null,
        projectId: typeof item.projectId === 'string' ? item.projectId : null,
    };
}

/** Terminal ids the daemon pushed, or null when the state carries no list this run wrote. */
export function webTerminalIds(state: unknown): Set<string> | null {
    const list = trustedTerminals(state);
    if (!list) return null;
    return new Set(list.map((t) => (t as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === 'string'));
}

/** daemonState.terminalViewOnly, restamped by this daemon run (`detectedAt >= startedAt`). */
export function viewOnlyCapable(state: unknown): boolean {
    const s = state as DaemonStateShape | null;
    const flag = s?.terminalViewOnly;
    if (!flag || flag.rpcAvailable !== true || typeof flag.detectedAt !== 'number') return false;
    return typeof s?.startedAt !== 'number' || flag.detectedAt >= s.startedAt;
}

/** Only the directory name of a cwd reaches a grantee (no home path, no user name). */
export function cwdBasename(cwd: string | null): string | null {
    if (!cwd) return null;
    const trimmed = cwd.replace(/[\\/]+$/, '');
    const base = trimmed.split(/[\\/]/).pop() ?? '';
    return base || null;
}

/** Business-audit payload: ids and counts only. */
export function terminalShareAuditPayload(grantId: string, detail: Record<string, unknown> | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = { grantId };
    for (const key of ['role', 'reason', 'bytes', 'enters', 'expiresAt', 'detached'] as const) {
        if (detail && detail[key] !== undefined) out[key] = detail[key];
    }
    return out;
}
