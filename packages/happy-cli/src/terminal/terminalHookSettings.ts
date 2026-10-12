/**
 * B-547: the I/O half of hook injection for daemon-typed `claude` commands —
 * the per-terminal `--settings` file and the cached `claude --version` probe
 * that decides which events that file may contain. Pure rules live in
 * agentHookStatus.ts. Nothing here touches the user's ~/.claude/settings.json.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { stableVersion } from '@/daemon/agentVersions';
import {
    buildTerminalHookSettings,
    injectClaudeSettingsFlag,
    isInjectableClaudeCommand,
    terminalHookCommand,
    terminalHookEventPlan,
} from './agentHookStatus';

export const TERMINAL_STATUS_FORWARDER_BASENAME = 'terminal_status_forwarder.cjs';

const VERSION_TTL_MS = 6 * 60 * 60_000;
const VERSION_RETRY_MS = 5 * 60_000;

function hooksDir(): string {
    return join(configuration.happyHomeDir, 'tmp', 'terminal-hooks');
}

export function terminalHookSettingsPath(terminalId: string): string {
    return join(hooksDir(), `${terminalId}.json`);
}

/**
 * Cached `claude --version` resolved with the SAME env the terminals get
 * (PATH incl. ~/.local/bin). Async and never awaited on the open path: until
 * the first probe lands, `current()` is null and nothing is injected.
 * Nothing is probed until `start()` (the daemon's list tracking) — a manager
 * that never tracks (tests, one-off tools) never injects.
 */
/** `claude --version` with the terminals' env; null when unresolvable. */
export function probeClaudeVersion(env: Record<string, string>): Promise<string | null> {
    return new Promise((resolveVersion) => {
        try {
            execFile('claude', ['--version'], { timeout: 5_000, maxBuffer: 32 * 1024, env }, (error, stdout) => {
                resolveVersion(error ? null : stableVersion(String(stdout)));
            });
        } catch {
            resolveVersion(null);
        }
    });
}

export class ClaudeVersionCache {
    private version: string | null = null;
    private checkedAt = 0;
    private inFlight: Promise<void> | null = null;
    private started = false;

    constructor(
        private readonly env: () => Record<string, string>,
        private readonly probe: (env: Record<string, string>) => Promise<string | null> = probeClaudeVersion,
    ) {}

    start(now = Date.now()): void {
        this.started = true;
        if (this.version === null || now - this.checkedAt > VERSION_TTL_MS) this.refresh(now);
    }

    current(now = Date.now()): string | null {
        if (!this.started) return null;
        const ttl = this.version ? VERSION_TTL_MS : VERSION_RETRY_MS;
        if (now - this.checkedAt > ttl) this.refresh(now);
        return this.version;
    }

    /** current(), but waits (bounded) for a probe already in flight —
     *  for paths that are async anyway (auto-restore). */
    async settled(timeoutMs: number): Promise<string | null> {
        const pending = this.inFlight;
        if (pending) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([pending, new Promise<void>((r) => { timer = setTimeout(r, timeoutMs); })]);
            if (timer) clearTimeout(timer);
        }
        return this.current();
    }

    private refresh(now: number): void {
        if (this.inFlight) return;
        this.checkedAt = now;
        this.inFlight = this.probe(this.env()).then((parsed) => {
            this.checkedAt = Date.now();
            // A failed probe keeps a previously good answer.
            if (parsed) this.version = parsed;
            logger.debug(`[TERMINAL HOOKS] claude --version → ${parsed ?? 'unresolved'}`);
        }, () => undefined).finally(() => {
            this.inFlight = null;
        });
    }
}

/**
 * Prepare hook injection for one terminal: write its settings file and
 * return the rewritten command. Returns the command unchanged when it is not
 * a bare `claude …`, the version is unknown/too old, or anything fails.
 */
export function withTerminalHooks(command: string, terminalId: string, claudeVersion: string | null): string {
    if (!isInjectableClaudeCommand(command)) return command;
    const events = terminalHookEventPlan(claudeVersion);
    if (!events) return command;
    const hookCommand = terminalHookCommand({
        forwarderPath: resolve(projectPath(), 'scripts', TERMINAL_STATUS_FORWARDER_BASENAME),
        terminalId,
        happyHome: configuration.happyHomeDir,
    });
    if (!hookCommand) return command;
    const path = terminalHookSettingsPath(terminalId);
    try {
        mkdirSync(hooksDir(), { recursive: true });
        writeFileSync(path, JSON.stringify(buildTerminalHookSettings(events, hookCommand), null, 2));
    } catch (error) {
        logger.debug(`[TERMINAL HOOKS] settings write failed for ${terminalId}: ${error}`);
        return command;
    }
    const injected = injectClaudeSettingsFlag(command, path);
    if (injected !== command) logger.debug(`[TERMINAL HOOKS] hooks injected for ${terminalId} (claude ${claudeVersion}, ${events.length} events)`);
    return injected;
}

export function removeTerminalHookSettings(terminalId: string): void {
    try {
        const path = terminalHookSettingsPath(terminalId);
        if (existsSync(path)) unlinkSync(path);
    } catch {
        // best-effort: a leftover file is tiny and overwritten on reuse
    }
}

/**
 * Daemon start: delete settings files whose terminal no longer exists (a
 * daemon killed hard never got to clean up). `isLive` must be authoritative
 * per id — a file of a LIVE terminal belongs to a claude that may still be
 * running and re-reading it. Returns the ids removed.
 */
export function sweepStaleTerminalHookSettings(isLive: (terminalId: string) => boolean): string[] {
    const removed: string[] = [];
    let names: string[];
    try {
        names = readdirSync(hooksDir());
    } catch {
        return removed;
    }
    for (const name of names) {
        const m = name.match(/^([A-Za-z0-9_-]{1,64})\.json$/);
        if (!m) continue;
        try {
            if (isLive(m[1])) continue;
            unlinkSync(join(hooksDir(), name));
            removed.push(m[1]);
        } catch {
            // best-effort
        }
    }
    return removed;
}
