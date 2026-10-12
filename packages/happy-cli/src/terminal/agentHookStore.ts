/**
 * B-547: per-terminal hook records held by the web-terminal manager.
 *
 * Thin stateful shell around the pure rules in agentHookStatus.ts: it owns
 * the records and pending interrupt baselines, and the one piece of I/O the
 * rules need — "is the claude process that reported these hooks still
 * alive?" (injected, so tests stay pure). In-memory only: a daemon restart
 * drops every record and the terminals fall back to the screen classifier
 * until their next hook.
 */

import type { AgentObservation } from './agentStatus';
import {
    decideInterrupt,
    fuseAgentState,
    armsInterruptCheck,
    parseTerminalAgentHook,
    pendingInterruptFor,
    reduceHookRecord,
    synthesizeInterruptDone,
    type FusedAgentState,
    type PendingInterrupt,
    type TerminalHookRecord,
} from './agentHookStatus';

export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: the process exists but belongs to someone else — still alive.
        return (error as NodeJS.ErrnoException)?.code === 'EPERM';
    }
}

export type InterruptCheckResult = 'synthesized' | 'wait' | 'drop' | 'none';

export class TerminalAgentHookStore {
    private records = new Map<string, TerminalHookRecord>();
    private pending = new Map<string, PendingInterrupt>();

    constructor(private readonly pidAlive: (pid: number) => boolean = isPidAlive) {}

    /** Apply one forwarded hook body. Returns the terminal whose list-relevant
     *  state changed (caller kicks a list refresh), or null. Never throws. */
    applyHook(body: unknown, now: number): { terminalId: string; changed: boolean } | null {
        const ev = parseTerminalAgentHook(body);
        if (!ev) return null;
        const prev = this.valid(ev.terminalId);
        const { record, changed } = reduceHookRecord(prev, ev, now);
        if (record) this.records.set(ev.terminalId, record);
        else this.records.delete(ev.terminalId);
        // Any newer hook supersedes a pending keypress baseline (the rule
        // would drop it anyway; this just frees it early).
        if (record?.seq !== prev?.seq) this.pending.delete(ev.terminalId);
        return { terminalId: ev.terminalId, changed };
    }

    /** The record if its claude process is still alive; dead ones are dropped. */
    valid(terminalId: string): TerminalHookRecord | undefined {
        const record = this.records.get(terminalId);
        if (!record) return undefined;
        if (record.claudePid !== undefined && !this.pidAlive(record.claudePid)) {
            this.records.delete(terminalId);
            this.pending.delete(terminalId);
            return undefined;
        }
        return record;
    }

    /** Screen observation (undefined = probe failed) → fused state. */
    fuse(terminalId: string, screen: AgentObservation | undefined, now: number): FusedAgentState {
        return fuseAgentState(screen, this.valid(terminalId), now);
    }

    /** A web keystroke reached the pane. True when it armed an inference
     *  check (Esc/Ctrl+C during a turn; also Enter on a dialog). */
    noteInput(terminalId: string, text: string, now: number): boolean {
        const record = this.records.get(terminalId);
        if (!record || !armsInterruptCheck(text, record.phase)) return false;
        const pending = pendingInterruptFor(this.valid(terminalId), now);
        if (!pending) return false;
        this.pending.set(terminalId, pending);
        return true;
    }

    /** Re-check an armed interrupt against a fresh screen observation. */
    checkInterrupt(terminalId: string, screen: AgentObservation | undefined, now: number): InterruptCheckResult {
        const pending = this.pending.get(terminalId);
        if (!pending) return 'none';
        const record = this.valid(terminalId);
        const verdict = decideInterrupt(record, pending, screen, now);
        if (verdict === 'wait') return 'wait';
        this.pending.delete(terminalId);
        if (verdict === 'drop' || !record) return 'drop';
        this.records.set(terminalId, synthesizeInterruptDone(record, now));
        return 'synthesized';
    }

    has(terminalId: string): boolean {
        return this.records.has(terminalId);
    }

    forget(terminalId: string): void {
        this.records.delete(terminalId);
        this.pending.delete(terminalId);
    }

    /** Drop records of terminals that no longer exist. */
    prune(liveIds: Iterable<string>): void {
        const keep = new Set(liveIds);
        for (const id of this.records.keys()) if (!keep.has(id)) this.forget(id);
        for (const id of this.pending.keys()) if (!keep.has(id)) this.pending.delete(id);
    }
}
