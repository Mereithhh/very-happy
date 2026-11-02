/**
 * B-867 operator tier — pure policy (spec specs/2026-11-session-sharing-operator.md §3, §4).
 *
 * Everything an operator may ask the owner's daemon to do passes through
 * `planOperatorCall`: an allowlist of ops, the session-cwd and permission-mode
 * caps, and the parameter rewrites (strip `allowTools`, force the terminal cwd,
 * forbid `startupCommand` / `attachTmux`). No I/O here so every rule is unit
 * tested; the broker (operatorBroker.ts) only executes the returned plan.
 */
import * as path from 'node:path';

export type OperatorErrorCode =
    | 'not_operator'
    | 'operator_method_denied'
    | 'operator_mode_escalation'
    | 'operator_path_denied'
    | 'operator_terminal_denied'
    | 'operator_terminal_limit'
    | 'cli_upgrade_required'
    | 'machine_unsupported'
    | 'machine_offline'
    | 'rpc_failed'
    | 'rate_limited'
    | 'bad_params';

export class OperatorError extends Error {
    constructor(readonly code: OperatorErrorCode) {
        // The code IS the message: params never reach an error string (Lead 11-03).
        super(code);
    }
}

/** Session RPCs an operator may call (forwarded to `${sessionId}:<method>` with the session DEK). */
export const OPERATOR_SESSION_METHODS = [
    'permission',
    'abort',
    'steer',
    'set-permission-mode',
    'session-run-intent',
    'btw-ask',
    'btw-poll',
    'btw-cancel',
    'readFile',
    'writeFile',
    'listDirectory',
    'getDirectoryTree',
    'ripgrep',
    'difftastic',
    'bash',
    'uploadFile',
    'uploadFileChunk',
    'codex-child-read',
] as const;
export type OperatorSessionMethod = typeof OPERATOR_SESSION_METHODS[number];

export const OPERATOR_TERMINAL_OPS = [
    'terminal.open',
    'terminal.attach',
    'terminal.history',
    'terminal.scroll',
    'terminal.paste',
    'terminal.kill',
    'terminal.list',
] as const;
export type OperatorTerminalOp = typeof OPERATOR_TERMINAL_OPS[number];

export const MAX_OPERATOR_TERMINALS_PER_GRANT = 4;

const SESSION_METHOD_SET = new Set<string>(OPERATOR_SESSION_METHODS);
const TERMINAL_OP_SET = new Set<string>(OPERATOR_TERMINAL_OPS);

export function isOperatorSessionMethod(op: string): op is OperatorSessionMethod {
    return SESSION_METHOD_SET.has(op);
}

export function isOperatorTerminalOp(op: string): op is OperatorTerminalOp {
    return TERMINAL_OP_SET.has(op);
}

// ---------------------------------------------------------------- permission mode cap

/**
 * Low → high. Unknown modes have no rank and are refused: a future mode must be
 * placed here deliberately before an operator can select it.
 */
const MODE_RANK: Record<string, number> = {
    'plan': 0,
    'read-only': 0,
    'default': 1,
    'acceptEdits': 2,
    'safe-yolo': 2,
    'bypassPermissions': 3,
    'yolo': 3,
};

export function permissionModeRank(mode: unknown): number | null {
    return typeof mode === 'string' && Object.prototype.hasOwnProperty.call(MODE_RANK, mode) ? MODE_RANK[mode] : null;
}

/**
 * May an operator select `requested` while the owner's session currently runs
 * `current` (metadata.permissionMode, the CLI-reported effective mode)? An
 * unreported current mode is treated as `default`.
 */
export function operatorMayUseMode(requested: unknown, current: unknown): boolean {
    const want = permissionModeRank(requested);
    if (want === null) return false;
    const have = permissionModeRank(current ?? 'default') ?? permissionModeRank('default')!;
    return want <= have;
}

// ---------------------------------------------------------------- paths

/** True when `candidate` (absolute or relative to `root`) stays inside `root`. */
export function pathWithinRoot(candidate: unknown, root: string): boolean {
    if (typeof candidate !== 'string' || candidate.includes('\0')) return false;
    const base = path.resolve(root);
    const resolved = path.resolve(base, candidate);
    return resolved === base || resolved.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

const PATH_PARAM_KEYS = ['path', 'cwd', 'subdir'] as const;

// ---------------------------------------------------------------- plans

export type OperatorSessionContext = {
    /** Session cwd from the owner's (unredacted) metadata. */
    cwd: string;
    /** metadata.permissionMode — the mode really in effect. */
    currentMode: unknown;
};

export type SessionCallPlan = {
    kind: 'session';
    method: OperatorSessionMethod;
    params: unknown;
    /** Metadata-only audit detail (never params). */
    audit: { kind: string; detail: Record<string, unknown> } | null;
};

function asObject(params: unknown): Record<string, unknown> {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new OperatorError('bad_params');
    return params as Record<string, unknown>;
}

/**
 * Validate and rewrite one operator session-RPC call. Throws OperatorError on
 * anything outside the operator's lane. The returned params are what the
 * owner's daemon receives.
 */
export function planOperatorSessionCall(method: string, rawParams: unknown, ctx: OperatorSessionContext): SessionCallPlan {
    if (!isOperatorSessionMethod(method)) throw new OperatorError('operator_method_denied');
    switch (method) {
        case 'permission': {
            const params = { ...asObject(rawParams) };
            // "Always allow" would permanently widen the owner's rules: never.
            delete params.allowTools;
            if (params.mode !== undefined && params.mode !== null) {
                if (!operatorMayUseMode(params.mode, ctx.currentMode)) throw new OperatorError('operator_mode_escalation');
            }
            return {
                kind: 'session', method, params,
                audit: { kind: 'permission', detail: { approved: params.approved === true, decision: typeof params.decision === 'string' ? params.decision : null, withMode: typeof params.mode === 'string' ? params.mode : null } },
            };
        }
        case 'set-permission-mode': {
            const params = asObject(rawParams);
            if (!operatorMayUseMode(params.mode, ctx.currentMode)) throw new OperatorError('operator_mode_escalation');
            return { kind: 'session', method, params, audit: { kind: 'mode', detail: { from: typeof ctx.currentMode === 'string' ? ctx.currentMode : null, to: params.mode } } };
        }
        case 'session-run-intent': {
            const params = { ...asObject(rawParams) };
            // Only model / effort: never a provider or account binding (B-794 / B-850).
            for (const key of Object.keys(params)) {
                if (!['modelIntent', 'model', 'effortIntent', 'effort'].includes(key)) delete params[key];
            }
            return { kind: 'session', method, params, audit: { kind: 'model', detail: { model: params.modelIntent ?? params.model ?? null, effort: params.effortIntent ?? params.effort ?? null } } };
        }
        case 'steer':
            // Steer carries no text: it ends the foreground turn so the queued
            // follow-up (sent as a signed shared message) runs next.
            return { kind: 'session', method, params: {}, audit: { kind: 'steer', detail: {} } };
        case 'abort':
            return { kind: 'session', method, params: rawParams ?? {}, audit: { kind: 'abort', detail: {} } };
        case 'btw-ask':
            return { kind: 'session', method, params: rawParams ?? {}, audit: { kind: 'btw', detail: {} } };
        case 'readFile':
        case 'writeFile':
        case 'listDirectory':
        case 'getDirectoryTree':
        case 'ripgrep':
        case 'difftastic':
        case 'bash':
        case 'uploadFile':
        case 'uploadFileChunk': {
            const params = asObject(rawParams);
            // The daemon already validatePath()s against the session cwd; this
            // is the second fence, on the server, before anything is forwarded.
            for (const key of PATH_PARAM_KEYS) {
                if (params[key] !== undefined && !pathWithinRoot(params[key], ctx.cwd)) throw new OperatorError('operator_path_denied');
            }
            const audited = method === 'writeFile' || method === 'uploadFile' || method === 'bash';
            if (!audited) return { kind: 'session', method, params, audit: null };
            const target = typeof params.path === 'string' ? params.path : typeof params.cwd === 'string' ? params.cwd : null;
            const detail: Record<string, unknown> = { path: target };
            if (method === 'bash' && typeof params.command === 'string') detail.command = params.command.slice(0, 200);
            return { kind: 'session', method, params, audit: { kind: method === 'bash' ? 'bash' : method === 'writeFile' ? 'file.write' : 'file.upload', detail } };
        }
        default:
            return { kind: 'session', method, params: rawParams ?? {}, audit: null };
    }
}

export type TerminalRegistryEntry = { terminalId: string; kind: 'opened' | 'attached' };

export type TerminalCallPlan =
    | { kind: 'machine'; method: 'open-terminal' | 'terminal-history' | 'terminal-scroll' | 'terminal-paste' | 'kill-terminal'; params: Record<string, unknown>; register?: TerminalRegistryEntry; unregister?: string; auditKind?: string }
    | { kind: 'list' };

export type OperatorTerminalContext = {
    cwd: string;
    /** metadata.terminalId — the session's own terminal, if any. */
    sessionTerminalId: string | null;
    /** This grant's live registry rows. */
    registry: TerminalRegistryEntry[];
    newTerminalId: () => string;
};

function dimension(value: unknown, fallback: number): number {
    return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 10_000 ? value as number : fallback;
}

function streamModeOf(params: Record<string, unknown>): { streamMode?: 'lines' } {
    return params.streamMode === 'lines' ? { streamMode: 'lines' } : {};
}

/** Validate and rewrite one operator terminal op into the owner's machine RPC. */
export function planOperatorTerminalCall(op: string, rawParams: unknown, ctx: OperatorTerminalContext): TerminalCallPlan {
    if (!isOperatorTerminalOp(op)) throw new OperatorError('operator_method_denied');
    const params = rawParams === undefined || rawParams === null ? {} : asObject(rawParams);
    const owned = (terminalId: unknown) => typeof terminalId === 'string' ? ctx.registry.find((entry) => entry.terminalId === terminalId) ?? null : null;
    switch (op) {
        case 'terminal.list':
            return { kind: 'list' };
        case 'terminal.open': {
            if (ctx.registry.filter((entry) => entry.kind === 'opened').length >= MAX_OPERATOR_TERMINALS_PER_GRANT) throw new OperatorError('operator_terminal_limit');
            const terminalId = ctx.newTerminalId();
            return {
                kind: 'machine', method: 'open-terminal',
                // Server-chosen id and cwd; encStream forced; no startupCommand / attachTmux, ever.
                params: { terminalId, cols: dimension(params.cols, 80), rows: dimension(params.rows, 24), cwd: ctx.cwd, encStream: true, ...streamModeOf(params) },
                register: { terminalId, kind: 'opened' },
                auditKind: 'terminal.open',
            };
        }
        case 'terminal.attach': {
            // `session: true` = the session's own terminal (metadata.terminalId is
            // redacted from grantees, so they ask for it by role, not by id).
            const terminalId = params.session === true ? ctx.sessionTerminalId : params.terminalId;
            const entry = owned(terminalId);
            const isSessionTerminal = typeof terminalId === 'string' && terminalId === ctx.sessionTerminalId;
            if (!entry && !isSessionTerminal) throw new OperatorError('operator_terminal_denied');
            const out: Record<string, unknown> = {
                terminalId, cols: dimension(params.cols, 80), rows: dimension(params.rows, 24),
                encStream: true, attachOnly: true,
            };
            if (Number.isSafeInteger(params.fromSeq) && (params.fromSeq as number) >= 0) out.fromSeq = params.fromSeq;
            if (typeof params.resub === 'boolean') out.resub = params.resub;
            Object.assign(out, streamModeOf(params));
            return {
                kind: 'machine', method: 'open-terminal', params: out,
                register: entry ? undefined : { terminalId: terminalId as string, kind: 'attached' },
                auditKind: entry ? undefined : 'terminal.attach',
            };
        }
        case 'terminal.history':
        case 'terminal.scroll':
        case 'terminal.paste': {
            if (!owned(params.terminalId)) throw new OperatorError('operator_terminal_denied');
            const method = op === 'terminal.history' ? 'terminal-history' : op === 'terminal.scroll' ? 'terminal-scroll' : 'terminal-paste';
            return { kind: 'machine', method, params: { ...params } };
        }
        case 'terminal.kill': {
            const entry = owned(params.terminalId);
            // Only what this operator opened; the session's own terminal is the owner's.
            if (!entry || entry.kind !== 'opened') throw new OperatorError('operator_terminal_denied');
            return { kind: 'machine', method: 'kill-terminal', params: { terminalId: entry.terminalId }, unregister: entry.terminalId, auditKind: 'terminal.kill' };
        }
    }
    throw new OperatorError('operator_method_denied');
}
