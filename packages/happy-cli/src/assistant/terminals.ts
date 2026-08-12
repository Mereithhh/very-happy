/**
 * Local tmux access for the assistant tool surface — B-051.
 *
 * Web terminals are tmux sessions named `vh-<terminalId>` with the
 * cross-device title stored in the `@vh_title` user option (source of truth:
 * terminal/webTerminal.ts — READ-ONLY reference here, we import only its
 * exported pure helpers and never touch its live pty machinery).
 *
 *   terminals_list → `tmux list-sessions -F <fmt>` filtered to `vh-*`
 *   terminal_read  → `tmux capture-pane -p -S -<lines>`
 *   terminal_send  → bracketed paste via `load-buffer` + `paste-buffer -p`
 *                    (B-013 precedent: paste, never synthesize keystrokes;
 *                    Enter is only sent when submit=true)
 *
 * Parsing is pure and unit-tested; the spawnSync wrappers are thin.
 */

import os from 'node:os'
import { spawnSync } from 'node:child_process'
import {
    LIST_FIELD_SEP,
    parseSessionListLine,
    deriveAutoTitle,
} from '@/terminal/webTerminal'

const TMUX_TIMEOUT_MS = 3000

/** Same field set webTerminal's list path requests (≥7 fields required by
 *  parseSessionListLine; pane_title last so embedded separators only ever
 *  garble the title). */
export const VH_LIST_SESSIONS_FORMAT = [
    '#{session_name}',
    '#{session_created}',
    '#{session_activity}',
    '#{pane_current_path}',
    '#{@vh_title}',
    '#{@vh_title_manual}',
    '#{pane_title}',
].join(LIST_FIELD_SEP)

export interface VhTerminal {
    id: string
    title?: string
    cwd?: string
    createdAt?: number
    activityAt?: number
}

/**
 * Parse `tmux list-sessions -F VH_LIST_SESSIONS_FORMAT` output into the
 * assistant-facing terminal list. Only `vh-*` sessions qualify (that prefix
 * IS the web-terminal namespace). Titles prefer the stored `@vh_title` and
 * fall back to a meaningful live pane title (deriveAutoTitle filters
 * hostname/bare-process junk). Pure; unit-tested.
 */
export function parseVhTerminals(stdout: string, hostname: string = os.hostname()): VhTerminal[] {
    const out: VhTerminal[] = []
    for (const line of stdout.split('\n')) {
        const s = parseSessionListLine(line)
        if (!s || !s.name.startsWith('vh-')) continue
        out.push({
            id: s.name.slice(3),
            title: s.vhTitle ?? deriveAutoTitle(s.paneTitle, hostname),
            cwd: s.cwd,
            createdAt: s.created,
            activityAt: s.activity,
        })
    }
    return out
}

function runTmux(args: string[], input?: string): { ok: boolean; stdout: string; error?: string } {
    try {
        const r = spawnSync('tmux', args, {
            encoding: 'utf8',
            timeout: TMUX_TIMEOUT_MS,
            input,
        })
        if (r.error) return { ok: false, stdout: '', error: r.error.message }
        if (r.status !== 0) return { ok: false, stdout: r.stdout ?? '', error: (r.stderr || `tmux exited with ${r.status}`).trim() }
        return { ok: true, stdout: r.stdout ?? '' }
    } catch (error) {
        return { ok: false, stdout: '', error: error instanceof Error ? error.message : String(error) }
    }
}

/** List the machine's web terminals straight from tmux. */
export function listVhTerminals(): { ok: boolean; terminals: VhTerminal[]; error?: string } {
    const r = runTmux(['list-sessions', '-F', VH_LIST_SESSIONS_FORMAT])
    if (!r.ok) {
        // `no server running` = zero terminals, not an error.
        if ((r.error ?? '').includes('no server running')) return { ok: true, terminals: [] }
        return { ok: false, terminals: [], error: r.error }
    }
    return { ok: true, terminals: parseVhTerminals(r.stdout) }
}

/** Exact-match pane target for a web terminal (see startupInjectionArgs docs
 *  in webTerminal.ts for why `=name:`). */
function target(terminalId: string): string {
    return `=vh-${terminalId}:`
}

/** Read the last `lines` of a terminal's visible history. */
export function readVhTerminal(terminalId: string, lines: number): { ok: boolean; text: string; error?: string } {
    const n = Math.max(1, Math.min(2000, Math.floor(lines)))
    const r = runTmux(['capture-pane', '-p', '-t', target(terminalId), '-S', `-${n}`])
    return { ok: r.ok, text: r.stdout, error: r.error }
}

const PASTE_BUFFER_NAME = 'vh-assistant-paste'

/**
 * Paste text into a terminal via tmux bracketed paste. `-p` makes tmux wrap
 * the paste in \x1b[200~ … \x1b[201~ when the pane's application enabled
 * bracketed paste (Claude Code does), so multi-line text lands as ONE paste
 * instead of executing line by line. Enter is sent ONLY when submit=true.
 */
export function sendToVhTerminal(terminalId: string, text: string, submit: boolean): { ok: boolean; error?: string } {
    // load-buffer from stdin: the text never goes through a shell or tmux
    // command parsing — it is opaque bytes.
    const load = runTmux(['load-buffer', '-b', PASTE_BUFFER_NAME, '-'], text)
    if (!load.ok) return { ok: false, error: `load-buffer failed: ${load.error}` }
    const paste = runTmux(['paste-buffer', '-p', '-d', '-b', PASTE_BUFFER_NAME, '-t', target(terminalId)])
    if (!paste.ok) return { ok: false, error: `paste-buffer failed: ${paste.error}` }
    if (submit) {
        const enter = runTmux(['send-keys', '-t', target(terminalId), 'Enter'])
        if (!enter.ok) return { ok: false, error: `send-keys Enter failed: ${enter.error}` }
    }
    return { ok: true }
}
