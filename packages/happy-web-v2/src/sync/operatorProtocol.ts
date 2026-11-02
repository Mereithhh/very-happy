/**
 * B-867 operator tier — wire constants and pure helpers shared by apiSocket,
 * the operator transport and the UI (spec specs/2026-11-session-sharing-operator.md §12).
 *
 * An operator never talks to the owner's daemon directly: every call goes to
 * the server broker as `operator-rpc` with params encrypted under the SESSION
 * key (the grantee already holds it). The server re-checks the grant, the
 * method allowlist, path / mode limits, and forwards with the owner's keys.
 * The lists here only decide what the web tries; the server is the authority.
 *
 * No imports on purpose: apiSocket must stay free of UI/text modules.
 */

/** Session RPC methods the broker forwards for an operator (spec §3.1). */
export const OPERATOR_SESSION_METHODS: ReadonlySet<string> = new Set([
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
]);

export type OperatorTerminalOp =
    | 'terminal.open'
    | 'terminal.attach'
    | 'terminal.history'
    | 'terminal.scroll'
    | 'terminal.paste'
    | 'terminal.kill'
    | 'terminal.list';

/** Stable error codes from the broker (spec §12.2). */
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
    | 'bad_params'
    | 'server_too_old';

export class OperatorRpcError extends Error {
    constructor(readonly code: string) {
        super(`operator: ${code}`);
    }
}

/** Every new terminal the operator UI opens / attaches starts at this size until the first fit. */
export const OPERATOR_TERMINAL_DEFAULT_SIZE = { cols: 100, rows: 30 } as const;

// ---------------------------------------------------------------- permission mode cap (spec §4)

/**
 * Rank of a permission mode, low → high. Unknown modes rank as null and are
 * refused (the server applies the same table).
 */
export function permissionModeRank(mode: string | null | undefined): number | null {
    switch (mode) {
        case 'plan':
        case 'read-only':
            return 0;
        case 'default':
            return 1;
        case 'acceptEdits':
        case 'safe-yolo':
            return 2;
        case 'bypassPermissions':
        case 'yolo':
            return 3;
        default:
            return null;
    }
}

/**
 * May an operator switch to `next` while the owner's session is in `ownerMode`
 * (the mode the CLI reports as in effect; unknown → 'default')? Lowering is
 * always allowed; raising above the owner's mode never is.
 */
export function operatorModeAllowed(next: string, ownerMode: string | null | undefined): boolean {
    const nextRank = permissionModeRank(next);
    if (nextRank === null) return false;
    const ownerRank = permissionModeRank(ownerMode) ?? 1;
    return nextRank <= ownerRank;
}

/**
 * The bound the operator's mode menu uses: the grant's cap from the server
 * (B-867b), else — on a server before B-867b — the owner's mode in effect.
 */
export function operatorModeBound(share: { modeCap?: string | null } | null | undefined, ownerMode: string | null | undefined): string | null {
    return share?.modeCap ?? ownerMode ?? null;
}

const CLAUDE_MODES = ['plan', 'default', 'acceptEdits', 'bypassPermissions'] as const;
const CODEX_MODES = ['read-only', 'default', 'safe-yolo', 'yolo'] as const;

/** Mode choices for a session flavor, each marked allowed under the owner's cap. Pure; tested. */
export function operatorModeChoices(flavor: string | null | undefined, ownerMode: string | null | undefined): Array<{ value: string; allowed: boolean }> {
    const modes: readonly string[] = flavor === 'codex' ? CODEX_MODES : CLAUDE_MODES;
    return modes.map((value) => ({ value, allowed: operatorModeAllowed(value, ownerMode) }));
}

/** Map a broker ack to a value or a typed error. Pure; unit-tested. */
export function readOperatorAck(ack: unknown): { ok: true; result: string } | { ok: false; code: string } {
    if (!ack || typeof ack !== 'object') return { ok: false, code: 'rpc_failed' };
    const a = ack as { ok?: unknown; result?: unknown; error?: unknown };
    if (a.ok === true && typeof a.result === 'string') return { ok: true, result: a.result };
    if (a.ok === true) return { ok: false, code: 'rpc_failed' };
    return { ok: false, code: typeof a.error === 'string' && a.error ? a.error : 'rpc_failed' };
}

// ---------------------------------------------------------------- terminal frames (spec §12.2)

export type OperatorTerminalOutput = { sessionId: string; terminalId: string; seq?: number; data: string };
export type OperatorTerminalExit = { sessionId: string; terminalId: string; exitCode: number };

function isStr(v: unknown): v is string { return typeof v === 'string' && v.length > 0; }

/** Validate a raw `operator-terminal-output` frame. Pure; unit-tested. */
export function parseOperatorOutput(raw: unknown): OperatorTerminalOutput | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (!isStr(r.sessionId) || !isStr(r.terminalId) || typeof r.data !== 'string') return null;
    if (r.seq !== undefined && !(typeof r.seq === 'number' && Number.isSafeInteger(r.seq))) return null;
    return { sessionId: r.sessionId, terminalId: r.terminalId, data: r.data, ...(typeof r.seq === 'number' ? { seq: r.seq } : {}) };
}

export function parseOperatorExit(raw: unknown): OperatorTerminalExit | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (!isStr(r.sessionId) || !isStr(r.terminalId) || typeof r.exitCode !== 'number') return null;
    return { sessionId: r.sessionId, terminalId: r.terminalId, exitCode: r.exitCode };
}

