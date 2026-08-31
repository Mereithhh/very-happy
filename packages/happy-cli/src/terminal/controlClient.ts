/**
 * B-121 terminal channel v2 — the tmux control-mode client (daemon side).
 *
 * One of these per live web terminal. It replaces the v1 node-pty running
 * `tmux attach-session -d`: a control client is a plain pipe child
 * (`tmux -C attach-session -t vh-<id>`), so it costs no /dev/ptmx slot and it
 * does not paint a screen — it delivers the pane's own output bytes plus a
 * command channel on the SAME connection, in one totally ordered stream.
 *
 * Responsibilities kept here (everything else is pure and lives in
 * controlModeDecoder / captureAssembly / sendKeysEncoding):
 *   - process lifecycle, including the hard stop discipline below;
 *   - the command FIFO: commands are written to stdin in order, and tmux
 *     answers with SOLICITED `%begin…%end` blocks in the same order, so a
 *     plain queue matches them (the attach greeting and hook-triggered blocks
 *     are unsolicited and must not consume a queue slot — that is exactly what
 *     `ControlModeBlockEvent.solicited` is for);
 *   - routing `%output` / notifications out to the session.
 *
 * ── Iron rules (each one is a real failure mode) ─────────────────────────────
 * 1. NEVER write a blank line to stdin: an empty line is tmux's "detach"
 *    command for a control client. Every command is validated before it goes
 *    out.
 * 2. A batch is ONE write. tmux runs the commands back to back and cannot
 *    interleave `%output` between the response blocks, which is what makes a
 *    multi-command capture a single point in time (spec D1).
 * 3. Stopping is SIGTERM → grace → SIGKILL. tmux 3.6b has a known bug where a
 *    control client with queued pane data can hang on exit (fixed in 3.7); the
 *    kill fallback costs nothing and must not depend on the tmux version.
 * 4. Commands never wait on each other's completion to be SENT (fire-and-
 *    forget writes stay ordered by the FIFO), so a slow tmux cannot stall
 *    keystrokes — measured 200 pipelined commands in 1.9ms.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '@/ui/logger';
import { ControlModeDecoder, type ControlModeEvent } from './controlModeDecoder';
import { tmuxArgs } from './tmuxSocket';

/** Grace between SIGTERM and SIGKILL when stopping a client (rule 3). */
export const CONTROL_CLIENT_KILL_GRACE_MS = 2000;

/** Default deadline for a command batch's responses (spec D1: the open path
 *  turns this into the `terminal-open-timeout` contract error). */
export const CONTROL_COMMAND_TIMEOUT_MS = 10_000;

export interface ControlClientHandlers {
    /** One decoded `%output` chunk (already octal-unescaped raw pane bytes). */
    onOutput: (pane: string, data: Buffer) => void;
    /** Any non-block notification (`layout-change`, `exit`, `window-*`, …). */
    onNotification: (name: string, args: string) => void;
    /** The child ended (tmux exited, session died, or we killed it). */
    onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

interface PendingCommand {
    resolve: (body: Buffer) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    label: string;
    /** Run SYNCHRONOUSLY the moment the block is decoded — before any later
     *  `%output` in the same stdout chunk is processed. The anchor needs this:
     *  a promise continuation is a microtask, and the decoder emits every event
     *  of one chunk synchronously, so `await` would read a seq that already
     *  counted output produced AFTER the capture. That reads as "the client
     *  already has it" and silently drops content. */
    onBlock?: (body: Buffer) => void;
}

export interface ControlCommandRequest {
    command: string;
    label?: string;
    onBlock?: (body: Buffer) => void;
}

/**
 * Validate one command line. Rejects the empty/whitespace-only line (rule 1)
 * and anything carrying its own newline (which would smuggle a second command
 * — or a detach — past the caller's intent).
 */
export function isSafeControlCommand(command: string): boolean {
    return command.trim().length > 0 && !/[\r\n]/.test(command);
}

export class ControlClient {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly decoder = new ControlModeDecoder();
    private readonly queue: PendingCommand[] = [];
    private stopping = false;
    private exited = false;

    constructor(
        private readonly tmuxSession: string,
        env: Record<string, string>,
        private readonly handlers: ControlClientHandlers,
    ) {
        // `-C` = control mode; no `-d`: a control client that never calls
        // `refresh-client -C` does not even participate in the window size, so
        // there is nothing to kick other clients for (v1's `attach -d` existed
        // only because the pty WAS the sizing client).
        this.child = spawn('tmux', tmuxArgs(['-C', 'attach-session', '-t', `=${tmuxSession}:`], env), {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
        }) as ChildProcessWithoutNullStreams;

        this.child.stdout.on('data', (chunk: Buffer) => this.consume(this.decoder.push(chunk)));
        this.child.stderr.on('data', (chunk: Buffer) => {
            logger.debug(`[CONTROL ${tmuxSession}] stderr: ${chunk.toString('utf8').trim()}`);
        });
        // ⚠️ TOOK THE WHOLE DAEMON DOWN ONCE (2026-08-17, first hour in
        // production): when the tmux session dies, the client's stdin closes,
        // and the very next write — a keystroke, a resize's `refresh-client`,
        // anything already in flight — raises EPIPE **as a stream error event**.
        // A stream error with no listener is an uncaught exception, and the
        // daemon's top-level handler treats that as fatal: `Starting proper
        // cleanup (source: exception, errorMessage: write EPIPE)` → every
        // terminal on the machine goes down because ONE terminal was closed.
        // The write path additionally refuses to write to a dead pipe (below),
        // but this listener is the belt: the race between "tmux went away" and
        // "we noticed" can never be closed from the writer's side alone.
        this.child.stdin.on('error', (e) => {
            logger.debug(`[CONTROL ${tmuxSession}] stdin error (session gone?): ${e}`);
        });
        this.child.stdout.on('error', (e) => {
            logger.debug(`[CONTROL ${tmuxSession}] stdout error: ${e}`);
        });
        this.child.stderr.on('error', () => { /* same discipline as stdout */ });
        this.child.on('error', (e) => {
            logger.debug(`[CONTROL ${tmuxSession}] spawn error: ${e}`);
            this.failAll(new Error(`control client failed: ${e}`));
        });
        this.child.on('exit', (code, signal) => {
            this.exited = true;
            this.consume(this.decoder.flush());
            this.failAll(new Error('control client exited'));
            this.handlers.onExit(code, signal);
        });
    }

    get pid(): number | undefined {
        return this.child.pid;
    }

    get alive(): boolean {
        return !this.exited;
    }

    /** Can we still write commands? `exited` alone is not enough: the child's
     *  exit event is async, so the pipe can already be gone while the flag says
     *  otherwise (that gap is exactly the EPIPE window). */
    private get writable(): boolean {
        return !this.exited && !this.stopping
            && this.child.stdin.writable && !this.child.stdin.destroyed;
    }

    private consume(events: ControlModeEvent[]): void {
        for (const ev of events) {
            if (ev.type === 'output') {
                this.handlers.onOutput(ev.pane, ev.data);
                continue;
            }
            if (ev.type === 'block') {
                // Unsolicited blocks (the attach greeting, hook output) are NOT
                // answers to anything we sent — matching them would shift the
                // whole FIFO by one and hand every command its neighbour's
                // response.
                if (!ev.solicited) continue;
                const pending = this.queue.shift();
                if (!pending) {
                    logger.debug(`[CONTROL ${this.tmuxSession}] unmatched block cmd=${ev.cmdNum}`);
                    continue;
                }
                clearTimeout(pending.timer);
                if (ev.error) pending.reject(new Error(`tmux command failed: ${pending.label}: ${ev.body.toString('utf8').trim()}`));
                else {
                    // Synchronous first (see PendingCommand.onBlock), then the
                    // promise — a throwing hook must not eat the response.
                    try { pending.onBlock?.(ev.body); } catch (e) { logger.debug(`[CONTROL ${this.tmuxSession}] onBlock threw: ${e}`); }
                    pending.resolve(ev.body);
                }
                continue;
            }
            if (ev.type === 'notification') {
                this.handlers.onNotification(ev.name, ev.args);
                continue;
            }
            logger.debug(`[CONTROL ${this.tmuxSession}] protocol error ${ev.reason}: ${ev.detail}`);
        }
    }

    private failAll(err: Error): void {
        while (this.queue.length > 0) {
            const p = this.queue.shift()!;
            clearTimeout(p.timer);
            p.reject(err);
        }
    }

    /**
     * Send a batch as ONE write (rule 2) and resolve with each command's block
     * body, in order. Rejects — without sending anything — if any line is
     * unsafe, so a malformed command can never detach the client.
     */
    send(commands: readonly ControlCommandRequest[], timeoutMs = CONTROL_COMMAND_TIMEOUT_MS): Promise<Buffer[]> {
        if (commands.length === 0) return Promise.resolve([]);
        for (const c of commands) {
            if (!isSafeControlCommand(c.command)) {
                return Promise.reject(new Error(`unsafe control command: ${JSON.stringify(c.command)}`));
            }
        }
        if (!this.writable) return Promise.reject(new Error('control client exited'));
        const promises = commands.map((c) => new Promise<Buffer>((resolve, reject) => {
            const timer = setTimeout(() => {
                // Do NOT shift the queue here: tmux may still answer, and the
                // FIFO must keep its alignment. The entry is left to be
                // resolved into the void (its promise is already settled).
                reject(new Error('control command timeout'));
            }, timeoutMs);
            timer.unref?.();
            this.queue.push({ resolve, reject, timer, label: c.label ?? c.command, onBlock: c.onBlock });
        }));
        this.writeRaw(`${commands.map((c) => c.command).join('\n')}\n`);
        return Promise.all(promises);
    }

    /**
     * Send without awaiting the responses — the input path (send-keys) uses
     * this: ordering is guaranteed by the single stdin FIFO, and waiting for
     * `%end` on every keystroke would add a round trip per character for no
     * benefit (rule 4). The responses still consume their queue slots.
     */
    sendFireAndForget(commands: string[]): void {
        const safe = commands.filter((c) => isSafeControlCommand(c));
        if (safe.length === 0 || !this.writable) return;
        for (const command of safe) {
            const timer = setTimeout(() => { /* nobody is waiting */ }, CONTROL_COMMAND_TIMEOUT_MS);
            timer.unref?.();
            this.queue.push({ resolve: () => { }, reject: () => { }, timer, label: command });
        }
        this.writeRaw(`${safe.join('\n')}\n`);
    }

    /** The ONE place that touches the pipe. A destroyed stream can also throw
     *  synchronously, so the try/catch is not redundant with the 'error'
     *  listener — both have taken this daemon down in one shape or another. */
    private writeRaw(text: string): void {
        try {
            this.child.stdin.write(text);
        } catch (e) {
            logger.debug(`[CONTROL ${this.tmuxSession}] write failed (session gone?): ${e}`);
        }
    }

    /** SIGTERM → grace → SIGKILL (rule 3). Resolves once the child is gone. */
    stop(graceMs = CONTROL_CLIENT_KILL_GRACE_MS): Promise<void> {
        if (this.exited) return Promise.resolve();
        if (this.stopping) return new Promise((resolve) => this.child.once('exit', () => resolve()));
        this.stopping = true;
        return new Promise((resolve) => {
            const killer = setTimeout(() => {
                logger.debug(`[CONTROL ${this.tmuxSession}] SIGTERM did not land in ${graceMs}ms — SIGKILL`);
                try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
            }, graceMs);
            killer.unref?.();
            this.child.once('exit', () => { clearTimeout(killer); resolve(); });
            try { this.child.kill('SIGTERM'); } catch { clearTimeout(killer); resolve(); }
        });
    }
}
