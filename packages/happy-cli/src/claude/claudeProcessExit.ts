/**
 * The one line a person reads when the Claude Code process dies (B-631; the
 * Codex counterpart is B-625's `Codex process exited (code=…): <stderr tail>`).
 *
 * The SDK already says why: its ProcessTransport rejects the `for await` with
 * `Claude Code process exited with code N. stderr: <tail>` or `… terminated
 * by signal SIGX. stderr: …` (sdk.mjs getProcessExitError / formatStderrTail).
 * The launcher used to flatten all of it into "Process exited unexpectedly",
 * so a signed-out CLI, a missing binary and an OOM kill all looked the same.
 *
 * Local mode spawns the CLI with inherited stdio, so it has no stderr tail;
 * its ExitCodeError / signal errors still get their code or signal.
 */

/** How much of the CLI's last stderr is kept — the same budget as Codex (B-625). */
export const CLAUDE_STDERR_TAIL_CHARS = 400;

const SDK_EXIT = /^Claude Code process (?:exited with code (-?\d+)|terminated by signal (\S+))(?:\. stderr: ([\s\S]*))?$/;
const LOCAL_EXIT_CODE = /^Process exited with code: (-?\d+)$/;
const LOCAL_SIGNAL = /^Process terminated with signal: (\S+)$/;

/** ANSI escapes out, whitespace folded to one line. */
function oneLine(text: string): string {
    return text
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b[()][A-Za-z0-9]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** The LAST `max` characters: the CLI's final words are the useful ones. */
function tailOf(text: string, max: number): string {
    return text.length > max ? `…${text.slice(text.length - (max - 1))}` : text;
}

/** `Process exited unexpectedly (code 1): <stderr tail>` — one line, or the bare prefix when nothing is known. */
export function describeClaudeProcessExit(error: unknown): string {
    const prefix = 'Process exited unexpectedly';
    const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    const message = raw.trim();
    if (!message) return prefix;

    const sdk = SDK_EXIT.exec(message);
    if (sdk) {
        const [, code, signal, stderr] = sdk;
        const how = signal ? `signal ${signal}` : `code ${code}`;
        const tail = stderr ? tailOf(oneLine(stderr), CLAUDE_STDERR_TAIL_CHARS) : '';
        return `${prefix} (${how})${tail ? `: ${tail}` : ''}`;
    }
    const localCode = LOCAL_EXIT_CODE.exec(message);
    if (localCode) return `${prefix} (code ${localCode[1]})`;
    const localSignal = LOCAL_SIGNAL.exec(message);
    if (localSignal) return `${prefix} (signal ${localSignal[1]})`;

    const detail = tailOf(oneLine(message), CLAUDE_STDERR_TAIL_CHARS);
    return detail ? `${prefix}: ${detail}` : prefix;
}
