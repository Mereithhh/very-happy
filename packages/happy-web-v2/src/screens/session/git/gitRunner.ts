/**
 * B-583/B-584: run git/gh through the existing session `bash` RPC, always in
 * the session's own working directory (`metadata.path`; the CLI additionally
 * rejects a cwd outside its working directory).
 *
 * The server forwards an RPC for at most 30s (AGENTS 17). Short commands run
 * synchronously with a ≤25s timeout. Commit / push / `gh pr create` can run a
 * hook for minutes, so on POSIX they start as a background job that returns
 * at once and are polled (`gitShell.buildJobStart/Poll`); cmd.exe has no
 * equivalent here and runs them synchronously, reporting a timeout honestly.
 */
import { sessionBash } from '@/sync/ops';
import { storage } from '@/sync/storage';
import type { ShellFlavor } from '../diffComments/gitDiff';
import { buildJobPoll, buildJobStart, parseJobPoll, parseJobStart } from './gitShell';

export type RunResult = {
    ok: boolean;
    exitCode: number | null;
    /** stdout then stderr (job mode: the interleaved log) */
    output: string;
    /** stdout alone (sync mode) — for machine-readable output such as gh JSON */
    stdout: string;
    truncated: boolean;
    timedOut: boolean;
    /** job still running when we stopped polling — state unknown */
    stillRunning: boolean;
};

export const SYNC_TIMEOUT_MS = 25_000;
export const JOB_DEADLINE_MS = 10 * 60_000;
const RPC_GRACE_MS = 5_000;

export function sessionCwd(sessionId: string): string | null {
    return storage.getState().sessions[sessionId]?.metadata?.path ?? null;
}

function failed(output: string, extra: Partial<RunResult> = {}): RunResult {
    return { ok: false, exitCode: null, output, stdout: '', truncated: false, timedOut: false, stillRunning: false, ...extra };
}

export async function runSync(sessionId: string, command: string, timeoutMs = SYNC_TIMEOUT_MS): Promise<RunResult> {
    const cwd = sessionCwd(sessionId);
    if (!cwd) return failed('no working directory');
    const timeout = Math.min(timeoutMs, SYNC_TIMEOUT_MS);
    // The web-side session RPC waits up to 5 min for a reply that a relay
    // hiccup may never deliver; never wait much past the command's own timeout.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const res = await Promise.race([
        sessionBash(sessionId, { command, cwd, timeout }),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeout + RPC_GRACE_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (!res) return failed('', { timedOut: true });
    // AGENTS 17: an RPC can resolve to `{ error }` with no other fields.
    const stdout = typeof res?.stdout === 'string' ? res.stdout : '';
    const stderr = typeof res?.stderr === 'string' ? res.stderr : '';
    const error = typeof res?.error === 'string' ? res.error : '';
    const timedOut = /timed out/i.test(error);
    const errPart = stderr || (res?.success ? '' : error);
    const output = stdout + (stdout && errPart && !stdout.endsWith('\n') ? '\n' : '') + errPart;
    return {
        ok: res?.success === true && res.exitCode === 0,
        exitCode: typeof res?.exitCode === 'number' ? res.exitCode : null,
        output,
        stdout,
        truncated: false,
        timedOut,
        stillRunning: false,
    };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
}

/**
 * Long command. Aborting (dialog closed) only stops polling — the job itself
 * finishes on the machine; the changes list shows the outcome on next refresh.
 */
export async function runJob(sessionId: string, body: string, flavor: ShellFlavor | null, signal?: AbortSignal, now: () => number = Date.now): Promise<RunResult> {
    if (flavor !== 'posix') return runSync(sessionId, body, SYNC_TIMEOUT_MS);
    const start = await runSync(sessionId, buildJobStart(body), 10_000);
    const dir = parseJobStart(start.output);
    if (!dir) return failed(start.output || 'could not start the command', { exitCode: start.exitCode, timedOut: start.timedOut });
    const poll = buildJobPoll(dir);
    if (!poll.ok) return failed('could not poll the command');
    const deadline = now() + JOB_DEADLINE_MS;
    let delay = 700;
    let misses = 0;
    while (!signal?.aborted) {
        await sleep(delay, signal);
        if (signal?.aborted) break;
        delay = Math.min(2000, delay + 300);
        const res = await runSync(sessionId, poll.command, 10_000);
        const state = parseJobPoll(res.output);
        if (!state) {
            // Transient RPC failure (relay hiccup): retry a few times before giving up.
            if (++misses >= 5) return failed(res.output || 'lost track of the command', { stillRunning: true });
            continue;
        }
        misses = 0;
        if (state.state === 'done') {
            return { ok: state.exitCode === 0, exitCode: state.exitCode, output: state.output, stdout: state.output, truncated: state.truncated, timedOut: false, stillRunning: false };
        }
        if (state.state === 'gone') return failed('', { stillRunning: true });
        if (now() > deadline) return failed('', { stillRunning: true });
    }
    return failed('', { stillRunning: true });
}
