/**
 * B-500: auto-title for a hand-run pi inside a vh web terminal.
 *
 * Claude Code names its terminal tab itself (its TUI writes the task summary
 * to the OSC title, which the daemon follows into `@vh_title`). Pi's TUI only
 * writes `π - <cwd>` — or `π - <session name> - <cwd>` once the session is
 * named — and never names a session on its own, so a pi terminal stayed
 * `π - <dir>` forever unless the model happened to call `change_title`.
 *
 * The fix keeps the Claude-shaped path: the pi extension asks its terminal
 * bridge (`very-happy mcp --terminal-tools`, this CLI) for a title on the first
 * prompt of an unnamed pi session, sets it as the PI SESSION NAME, pi rewrites
 * its OSC title, and `deriveAutoTitle` (webTerminal.ts) extracts the name from
 * that format. Nothing is written to tmux directly, so a manual sidebar rename
 * (`@vh_title_manual`) keeps winning exactly as it does for Claude.
 *
 * The request is a custom JSON-RPC method on the bridge, NOT an MCP tool: the
 * model must never see or call it (B-493 measured the cost of a forced
 * `change_title` round-trip; this path costs the model zero turns).
 */
import { z } from 'zod';

export const TERMINAL_TITLE_SUGGEST_METHOD = 'very-happy/terminal-title-suggest';

export const TerminalTitleSuggestRequestSchema = z.object({
    method: z.literal(TERMINAL_TITLE_SUGGEST_METHOD),
    params: z.object({
        /** The user's first prompt; the bridge samples its head (buildPrompt). */
        prompt: z.string().min(1).max(20_000),
    }),
});

export const TerminalTitleSuggestResultSchema = z.object({
    /** Sanitized title, or null when nothing usable came back (keep the old title). */
    title: z.string().nullable(),
});
export type TerminalTitleSuggestResult = z.infer<typeof TerminalTitleSuggestResultSchema>;

/** `basename` without importing node:path into the pure title helpers. */
function baseName(cwd: string): string {
    const trimmed = cwd.replace(/[\\/]+$/, '');
    const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Extract the pi session name from pi's OSC title, or undefined when the title
 * is not pi's named form. Pi (verified 0.84.4, `updateTerminalTitle`) writes
 * `${APP_TITLE} - ${sessionName} - ${cwdBasename}` when the session has a
 * name and `${APP_TITLE} - ${cwdBasename}` otherwise; APP_TITLE is `π` or the
 * piConfig name (default `pi`). The cwd basename is the discriminator: a
 * session name may itself contain ` - `, so the suffix is matched, not split.
 * Unnamed titles return undefined and keep today's `π - <dir>` fallback.
 * Pure; unit-tested.
 */
export function piSessionNameFromTitle(title: string, cwd: string | undefined): string | undefined {
    const m = /^(?:π|pi) - (.+)$/u.exec(title);
    if (!m || !cwd) return undefined;
    const suffix = ` - ${baseName(cwd)}`;
    const rest = m[1];
    if (!rest.endsWith(suffix)) return undefined;
    const name = rest.slice(0, -suffix.length).trim();
    return name || undefined;
}
