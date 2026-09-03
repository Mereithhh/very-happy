/**
 * Pure parsers for vh-supervisor conversation artefacts (B-353, spec §B).
 *
 * Fixtures come from vh-supervisor `src/tickRender.js` (tick message), `charter/SUPERVISOR.md` §3
 * (decision JSON) and `vh-ledger` argv as used in `test/ledgerCli.test.js`. Every parser returns
 * `null` on any mismatch so the caller falls back to today's rendering.
 */

export const DECISION_ACTIONS = ['accept', 'followup', 'stop', 'escalate', 'approve', 'deny', 'dispatch', 'note'] as const;
export type DecisionAction = typeof DECISION_ACTIONS[number];

export const TICK_ITEM_KINDS = ['dispatch', 'checkin', 'permission', 'review', 'missing', 'orphan'] as const;
export type TickItemKind = typeof TICK_ITEM_KINDS[number];

export type TickPendingRequest = { id: string; tool: string | null; waiting: string | null; description: string | null };

export type TickItem = {
    number: number;
    kind: TickItemKind;
    taskId: string | null;
    goal: string | null;
    autonomy: string | null;
    status: string | null;
    /** `untracked session <id>` head form. */
    untrackedSessionId: string | null;
    sessionRef: string | null;
    sessionId: string | null;
    sessionState: string | null;
    machine: string | null;
    title: string | null;
    cwd: string | null;
    acceptance: string[];
    pendingRequests: TickPendingRequest[];
    commands: string[];
};

export type TickReport = {
    at: string;
    summary: string;
    items: TickItem[];
    footnotes: string[];
};

const TICK_HEAD = /^\[vh-tick (\S+)\] (.*)$/;
const ITEM_HEAD = /^## (\d+)\. ([a-z]+) — (.*)$/;
const TRACKED_HEAD = /^(T-\d+) "(.*)" \(autonomy: ([^,]+), status: ([^)]+)\)$/;
const UNTRACKED_HEAD = /^untracked session (\S+)$/;
const SESSION_LINE = /^session: (\S+) \((.*)\)$/;
const REQUEST_LINE = /^- (\S+)(?: \(([^)]*)\))?(?: waiting (\S+))?(?:: (.*))?$/;

export function parseTickReport(text: string): TickReport | null {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const head = TICK_HEAD.exec(lines[0] ?? '');
    if (!head) return null;
    const items: TickItem[] = [];
    const footnotes: string[] = [];
    let current: TickItem | null = null;
    let section: 'acceptance' | 'requests' | 'commands' | null = null;
    for (const rawLine of lines.slice(1)) {
        const itemHead = ITEM_HEAD.exec(rawLine);
        if (itemHead) {
            const kind = itemHead[2];
            if (!(TICK_ITEM_KINDS as readonly string[]).includes(kind)) return null;
            const tracked = TRACKED_HEAD.exec(itemHead[3]);
            const untracked = UNTRACKED_HEAD.exec(itemHead[3]);
            if (!tracked && !untracked) return null;
            current = {
                number: Number(itemHead[1]),
                kind: kind as TickItemKind,
                taskId: tracked ? tracked[1] : null,
                goal: tracked ? tracked[2] : null,
                autonomy: tracked ? tracked[3] : null,
                status: tracked ? tracked[4] : null,
                untrackedSessionId: untracked ? untracked[1] : null,
                sessionRef: null, sessionId: null, sessionState: null, machine: null, title: null, cwd: null,
                acceptance: [], pendingRequests: [], commands: [],
            };
            items.push(current);
            section = null;
            continue;
        }
        const line = rawLine.trim();
        if (!current) {
            if (/^_.*_$/.test(line)) footnotes.push(line.slice(1, -1));
            continue;
        }
        if (line === '') continue;
        if (/^_.*_$/.test(line)) { footnotes.push(line.slice(1, -1)); current = null; continue; }
        if (line === 'acceptance:') { section = 'acceptance'; continue; }
        if (line === 'pending requests:') { section = 'requests'; continue; }
        if (line === 'commands:') { section = 'commands'; continue; }
        const session = SESSION_LINE.exec(line);
        if (session) {
            section = null;
            current.sessionRef = session[1];
            current.sessionId = session[1].split('/').pop() ?? session[1];
            for (const part of session[2].split(', ')) {
                if (part.startsWith('machine ')) current.machine = part.slice('machine '.length);
                else if (part.startsWith('state ')) current.sessionState = part.slice('state '.length);
            }
            continue;
        }
        if (line.startsWith('title: ')) { section = null; current.title = line.slice(7); continue; }
        if (line.startsWith('cwd: ')) { section = null; current.cwd = line.slice(5); continue; }
        if (line.startsWith('cwd (ledger): ')) { section = null; current.cwd ??= line.slice('cwd (ledger): '.length); continue; }
        if (line.startsWith('allowed for tier ')) { section = null; continue; }
        if (section === 'acceptance') {
            const m = /^(\d+)\. (.*)$/.exec(line);
            if (m) { current.acceptance.push(m[2]); continue; }
        }
        if (section === 'requests') {
            const m = REQUEST_LINE.exec(line);
            if (m) {
                const tool = m[2] && !m[2].startsWith('tool not reported') ? m[2] : null;
                current.pendingRequests.push({ id: m[1], tool, waiting: m[3] ?? null, description: m[4] ?? null });
                continue;
            }
        }
        if (section === 'commands') { current.commands.push(line); continue; }
        // Unknown field inside an item: tolerated (kept out of the card) so a newer tickRender still parses.
    }
    if (items.length === 0) return null;
    return { at: head[1], summary: head[2], items, footnotes };
}

export type Decision = {
    /** null for decisions about untracked sessions (orphan escalations). */
    taskId: string | null;
    action: DecisionAction;
    reason: string | null;
    citedAcceptance: number[];
    requestId: string | null;
    message: string | null;
    command: string | null;
};

export type DecisionBlock = {
    /** Assistant text with the decisions block removed (rendered as normal markdown above the card). */
    prose: string;
    decisions: Decision[];
};

const FENCED_JSON = /```json[ \t]*\n([\s\S]*?)\n[ \t]*```/g;

/** Parse an assistant reply whose LAST fenced ```json block is a charter decision array. */
export function parseDecisionBlock(text: string): DecisionBlock | null {
    let last: RegExpExecArray | null = null;
    for (let m = FENCED_JSON.exec(text); m; m = FENCED_JSON.exec(text)) last = m;
    FENCED_JSON.lastIndex = 0;
    if (!last) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(last[1]);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const decisions: Decision[] = [];
    for (const entry of parsed) {
        if (typeof entry !== 'object' || entry === null) return null;
        const e = entry as Record<string, unknown>;
        if (!(typeof e.taskId === 'string' || e.taskId === null) || typeof e.action !== 'string') return null;
        if (!(DECISION_ACTIONS as readonly string[]).includes(e.action)) return null;
        decisions.push({
            taskId: typeof e.taskId === 'string' ? e.taskId : null,
            action: e.action as DecisionAction,
            reason: typeof e.reason === 'string' ? e.reason : null,
            citedAcceptance: Array.isArray(e.citedAcceptance) ? e.citedAcceptance.filter((n): n is number => Number.isInteger(n)) : [],
            requestId: typeof e.requestId === 'string' ? e.requestId : null,
            message: typeof e.message === 'string' ? e.message : null,
            command: typeof e.command === 'string' ? e.command : null,
        });
    }
    const prose = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim();
    return { prose, decisions };
}

export type LedgerOp = {
    subcommand: 'add' | 'bind' | 'decide';
    taskId: string | null;
    action: DecisionAction | null;
    reason: string | null;
    cite: number[];
    requestId: string | null;
    sessionId: string | null;
    goal: string | null;
    raw: string;
};

// Global `--ledger <path>` may precede the subcommand (vh-ledger's only global flag).
const LEDGER_HEAD = /^(?:\S*\/)?vh-ledger\s+(?:--ledger\s+\S+\s+)?(add|bind|decide)\b/;
/** Shell control/expansion characters; unquoted, they mean the command is not a bare ledger op. */
const SHELL_CONTROL = /[;|&`$(){}<>]/;

/** Parse a `vh-ledger add|bind|decide …` shell command into a compact op; null for anything else. */
export function parseLedgerOp(command: string): LedgerOp | null {
    const trimmed = command.trim();
    const head = LEDGER_HEAD.exec(trimmed);
    if (!head) return null;
    // splitArgv is null for a chained/piped command (`… && rm -rf x`) — it must not collapse
    // to a harmless-looking `ledger: T-1 ← accept` header; only the bare ledger op qualifies.
    const argv = splitArgv(trimmed);
    if (!argv) return null;
    const subcommand = head[1] as LedgerOp['subcommand'];
    const subIndex = argv.indexOf(subcommand, 1);
    if (subIndex < 1) return null;
    const rest = argv.slice(subIndex + 1);
    const flag = (name: string): string | null => {
        const i = rest.indexOf(name);
        return i >= 0 && i + 1 < rest.length ? rest[i + 1] : null;
    };
    const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && !rest[i - 1].includes('=')));
    const actionRaw = flag('--action');
    if (actionRaw !== null && !(DECISION_ACTIONS as readonly string[]).includes(actionRaw)) return null;
    const cite = (flag('--cite') ?? '').split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number);
    return {
        subcommand,
        taskId: subcommand === 'add' ? null : positional[0] ?? null,
        action: actionRaw as DecisionAction | null,
        reason: flag('--reason'),
        cite,
        requestId: flag('--request'),
        sessionId: subcommand === 'bind' ? positional[1] ?? null : flag('--session'),
        goal: flag('--goal'),
        raw: trimmed,
    };
}

/** Minimal POSIX-ish argv split (double/single quotes, backslash escapes); null on unterminated
 * quote or on any unquoted shell control/expansion character (quoted `--reason "a & b"` is fine). */
function splitArgv(cmd: string): string[] | null {
    const out: string[] = [];
    let cur = '';
    let quote: '"' | "'" | null = null;
    let has = false;
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        if (quote) {
            if (ch === quote) quote = null;
            else if (ch === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
            else cur += ch;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
        if (ch === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue; }
        if (/\s/.test(ch)) { if (has) { out.push(cur); cur = ''; has = false; } continue; }
        if (SHELL_CONTROL.test(ch)) return null;
        cur += ch; has = true;
    }
    if (quote) return null;
    if (has) out.push(cur);
    return out;
}
