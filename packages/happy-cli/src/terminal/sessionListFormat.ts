/**
 * Pure `tmux list-sessions` format + parsers for the web-terminal list
 * (moved verbatim out of ./webTerminal.ts, B-512).
 *
 * assistant/terminals.ts parses the same lines and is loaded by every Claude
 * wrapper's MCP server; importing them from webTerminal.ts dragged node-pty and
 * the headless xterm into each session start. webTerminal.ts re-exports all of
 * this, so existing importers are unchanged.
 */
import { piSessionNameFromTitle } from './terminalTitleSuggest';
import { isSafeTmuxSessionName } from './userTmuxSessions';

export const SHELL_COMMANDS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh']);

/**
 * ── Auto-title: follow the pane's OSC title ──────────────────────────────────
 * Claude Code's TUI continuously sets the terminal window title (OSC 0/2) to a
 * short summary of the current task — tmux stores it as `#{pane_title}`
 * (verified on tmux 3.6b: "✳ 与ted沟通GPU成本口径", "◐ webhook-integration-setup";
 * `allow-rename` only affects the WINDOW name, not pane_title). That is exactly
 * the title a user wants in the sidebar, so listSessions() follows it into
 * `@vh_title` (the cross-device title truth) on every poll — unless the user
 * manually renamed the terminal (`@vh_title_manual`, see setTitle).
 *
 * A plain shell doesn't set a useful OSC title — the tmux DEFAULT pane_title is
 * the machine's hostname — so deriveAutoTitle() filters that (and bare process
 * names) out; shell terminals keep their web-side first-command fallback title.
 */

/** Max auto-title length in code points (matches the web's own 60-char cap). */
const TITLE_MAX_CHARS = 60;

/** pane_title values that carry no information: the tmux default (hostname,
 *  handled separately), bare shell/process names, and tmux itself. */
const JUNK_TITLES = new Set(['tmux', 'claude', 'node', ...SHELL_COMMANDS]);

/**
 * Turn a raw `#{pane_title}` into a sidebar-worthy auto title, or undefined
 * when it says nothing. Strips the leading status glyph(s) Claude Code puts in
 * its OSC title ("✳ <task>" / "◐ <task>" — the spinner set varies by version,
 * so strip ANY leading non-letter/digit run), collapses whitespace, drops the
 * tmux default title (hostname, full or short form) and bare process names,
 * and truncates to TITLE_MAX_CHARS code points. Pure; unit-tested.
 */
export function deriveAutoTitle(paneTitle: unknown, hostname: string, cwd?: string): string | undefined {
    if (typeof paneTitle !== 'string') return undefined;
    const t = paneTitle.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim();
    if (!t) return undefined;
    // B-500: pi's TUI writes `π - <session name> - <cwd basename>` once the
    // session is named (the pi extension names it from the first prompt) —
    // the name alone is the tab title, like Claude's task summary. Unnamed
    // `π - <dir>` falls through unchanged.
    const piName = piSessionNameFromTitle(t, cwd);
    if (piName) {
        const chars = Array.from(piName);
        return chars.length > TITLE_MAX_CHARS ? chars.slice(0, TITLE_MAX_CHARS).join('') : piName;
    }
    const lower = t.toLowerCase();
    const host = (hostname || '').toLowerCase();
    const shortHost = host.split('.')[0];
    if (host && (lower === host || lower === shortHost)) return undefined;
    if (JUNK_TITLES.has(lower)) return undefined;
    const chars = Array.from(t);
    return chars.length > TITLE_MAX_CHARS ? chars.slice(0, TITLE_MAX_CHARS).join('') : t;
}

/** Field separator for the list-sessions format below. Titles and paths are
 *  free text that may contain tabs; US (0x1f) can't be typed into a terminal
 *  title in practice. pane_title is deliberately the LAST field so even a
 *  pathological embedded separator only garbles the title, never the fields.
 *
 *  The separator is a PRINTABLE ASCII sentinel, not a control character and
 *  not a fancy Unicode one, because tmux munges both in format output in
 *  version/locale-dependent ways (2026-09-02, container-verified): ≤3.2a
 *  replaces control characters with `_` (unrecoverable — the old 0x1f
 *  separator silently broke this parse, so those machines listed ZERO
 *  terminals), 3.4/3.5 octal-escape them (`\037`), and under a C locale
 *  even printable multibyte characters (U+241F tried first) collapse to
 *  `_`. Plain printable ASCII survives everywhere; this exact sequence is
 *  not going to appear in a title/path/tag. */
export const LIST_FIELD_SEP = '<~|~>';

/** The ONE list-sessions field set. Exported because the assistant's terminal
 *  list (assistant/terminals.ts) parses the same lines with the same parser —
 *  a second copy of this array silently desyncs the moment a field is added
 *  (B-121 added pane_current_command and broke exactly that). */
export const LIST_SESSIONS_FORMAT = [
    '#{session_name}',
    '#{session_created}',
    '#{session_activity}',
    '#{pane_current_path}',
    '#{@vh_title}',
    '#{@vh_title_manual}',
    '#{@vh_tags}',
    // B-273: the user tmux session this terminal was opened to attach (name),
    // carried into close records so a restore can re-attach.
    '#{@vh_attach}',
    // B-287: the pane's REAL geometry, persisted with the live snapshot so a
    // cold restore (daemon boot auto-restore, archive ↻) recreates the session
    // at the size it last had — claude's one-shot welcome banner then never
    // gets reflowed by the first web open (the "half-drawn logo").
    '#{pane_width}',
    '#{pane_height}',
    // B-121: the control-mode client has no `pty.process`, so the agent-state
    // fast path lost its live `#{pane_current_command}` equivalent. Carry it in
    // the ONE list-sessions call the tracker already makes — the value goes
    // from "live" to "≤ LIST_TRACK_INTERVAL_MS old", which classifyPane
    // tolerates (its dialog/working judgments come from the pane TEXT; the
    // command only separates shell/idle). MUST stay before pane_title: that
    // field is deliberately last so a pathological 0x1f inside a title can only
    // garble the title, never shift the fields.
    '#{pane_current_command} #{pane_pid}',
    '#{pane_title}',
].join(LIST_FIELD_SEP);

export interface SessionListLine {
    name: string;
    created?: number;   // epoch ms
    activity?: number;  // epoch ms
    cwd?: string;
    /** Current `@vh_title` (trimmed), if any. */
    vhTitle?: string;
    /** `@vh_title_manual` is set → the user renamed it; never auto-follow. */
    manual: boolean;
    /** Parsed `@vh_tags`; missing or malformed local values fail closed to []. */
    tags: string[];
    /** `#{pane_current_command}` of the active pane (B-121: the poll-cadence
     *  replacement for the pty's live foreground name). */
    paneCurrentCommand?: string;
    panePid?: number;
    /** B-273: `@vh_attach` — name of the user tmux session attached inside. */
    attachTmux?: string;
    /** B-287: `#{pane_width}` / `#{pane_height}` of the active pane; absent
     *  when tmux printed anything but a positive integer. */
    paneCols?: number;
    paneRows?: number;
    /** Raw `#{pane_title}` of the session's active pane. */
    paneTitle?: string;
}

/** Parse one `list-sessions -F LIST_SESSIONS_FORMAT` line. Pure; unit-tested. */
export function parseSessionListLine(line: string): SessionListLine | undefined {
    if (!line) return undefined;
    const parts = line.split(LIST_FIELD_SEP);
    if (parts.length < 12) return undefined;
    const [name, created, activity, cwd, vhTitle, manual, vhTags, vhAttach, paneW, paneH, paneCommand] = parts;
    if (!name) return undefined;
    const geom = parsePositiveInt(paneW) !== undefined && parsePositiveInt(paneH) !== undefined
        ? { paneCols: parsePositiveInt(paneW)!, paneRows: parsePositiveInt(paneH)! }
        : {};
    return {
        name,
        created: created ? Number(created) * 1000 : undefined,
        activity: activity ? Number(activity) * 1000 : undefined,
        cwd: cwd || undefined,
        vhTitle: vhTitle.trim() || undefined,
        manual: manual.trim().length > 0,
        tags: parseTerminalTags(vhTags),
        paneCurrentCommand: paneCommand.trim().replace(/ \d+$/, '') || undefined,
        ...( / (\d+)$/.test(paneCommand) ? { panePid: Number(paneCommand.match(/ (\d+)$/)![1]) } : {}),
        // Verbatim (no trim): tmux allows edge spaces in a session name and the
        // restore lookup / attach echo compare it exactly.
        attachTmux: isSafeTmuxSessionName(vhAttach) ? vhAttach : undefined,
        ...geom,
        // pane_title is last, so anything after field 11 is title content that
        // contained the separator — rejoin it rather than dropping it.
        paneTitle: parts.slice(11).join(LIST_FIELD_SEP) || undefined,
    };
}

function parsePositiveInt(raw: string | undefined): number | undefined {
    if (raw === undefined || !/^[0-9]{1,5}$/.test(raw.trim())) return undefined;
    const n = Number(raw.trim());
    return n > 0 ? n : undefined;
}

export const TERMINAL_TAG_MAX_COUNT = 64;
export const TERMINAL_TAG_MAX_LENGTH = 24;
export const TERMINAL_TAGS_MAX_BYTES = 4096;

/** Validate the canonical tag shape produced by the Web editor. Returning
 * undefined distinguishes invalid RPC input from a valid empty list. */
export function validateTerminalTags(value: unknown): string[] | undefined {
    if (!Array.isArray(value) || value.length > TERMINAL_TAG_MAX_COUNT) return undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const valueTag of value) {
        if (typeof valueTag !== 'string') return undefined;
        const tag = valueTag.trim().replace(/^#+/, '').trim().replace(/\s+/g, '-').slice(0, TERMINAL_TAG_MAX_LENGTH);
        if (!tag || tag !== valueTag) return undefined;
        const key = tag.toLowerCase();
        if (seen.has(key)) return undefined;
        seen.add(key);
        out.push(tag);
    }
    if (Buffer.byteLength(JSON.stringify(out), 'utf8') > TERMINAL_TAGS_MAX_BYTES) return undefined;
    return out;
}

/** Local tmux state is user-editable; a corrupt option must never poison the
 * whole terminal snapshot. */
export function parseTerminalTags(raw: unknown): string[] {
    if (typeof raw !== 'string' || !raw.trim()) return [];
    try {
        return validateTerminalTags(JSON.parse(raw)) ?? [];
    } catch {
        return [];
    }
}
