/**
 * B-544: the wrapper side of "a rewind is provisional until the durable log
 * confirms it". Thin I/O around the pure rules in rewindReconcile.ts:
 *
 *   begin(record)  after a successful `conversation-rewind` that carried a
 *                  requestId — records `metadata.rewind` (state pending) and
 *                  arms the confirm deadline;
 *   observe(body)  every inbound session record — a `transcript-drop` with the
 *                  pending requestId confirms at once;
 *   check()        poll / deadline — re-reads the server log before acting, so
 *                  a missed live record can never cause a wrong revert;
 *   startup()      once per wrapper process, before the first prompt runs —
 *                  decides a leftover pending record, or repairs a legacy
 *                  split (unconfirmed rewound copy, no record);
 *   settled()      prompts wait on it while a rewind is pending.
 */

import {
    chainRewindRecord,
    decideLineageRepair,
    decideRewind,
    parseRewindRecord,
    tombstoneRequestIds,
    transcriptDropOf,
    transcriptLineage,
    visibleUserLocalIds,
    type LogRecord,
    type RewindDecision,
    type RewindRecord,
} from './rewindReconcile';

/** While pending, re-read the server log this often (covers a missed live record). */
export const REWIND_POLL_MS = 15_000;

export type RewindReconcilerDeps = {
    now: () => number;
    /** `metadata.rewind` as the wrapper knows it now. */
    readRecord: () => unknown;
    /** Persist `metadata.rewind`; resolves once the server holds it (or gives up). */
    writeRecord: (record: RewindRecord) => Promise<void>;
    /** Newest window of decrypted session records, ascending seq. */
    readLog: () => Promise<LogRecord[]>;
    currentClaudeSessionId: () => string | null;
    /** Lines of `<id>.jsonl` in the project dir; null when the file is missing. */
    readTranscript: (claudeSessionId: string) => Promise<string[] | null>;
    /** Point the agent at `claudeSessionId` (null = fresh) and relaunch silently. */
    switchConversation: (claudeSessionId: string | null) => Promise<void>;
    log: (message: string, data?: unknown) => void;
};

export class RewindReconciler {
    private pending: RewindRecord | null = null;
    /** The last rewind this process rolled back — a late tombstone re-applies it. */
    private lastReverted: RewindRecord | null = null;
    private readonly confirmedIds = new Set<string>();
    private waiters: Array<() => void> = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private checking: Promise<void> | null = null;
    private disposed = false;

    constructor(private readonly deps: RewindReconcilerDeps) {}

    get pendingRecord(): RewindRecord | null {
        return this.pending;
    }

    /** Synchronously marks the rewind pending; the returned promise is the metadata write. */
    begin(record: Omit<RewindRecord, 'state'>): Promise<void> {
        const next = chainRewindRecord({ ...record, state: 'pending' }, this.pending);
        this.pending = next;
        this.arm(next);
        this.deps.log(`[rewind] pending ${next.requestId}: ${next.sourceClaudeSessionId} -> ${next.claudeSessionId ?? '(fresh)'}`);
        const written = this.deps.writeRecord(next);
        // The tombstone can only follow the record, but never lose one that raced ahead.
        if (this.confirmedIds.has(next.requestId)) void this.apply(next, { kind: 'confirm' });
        return written;
    }

    /** Every inbound session record. */
    observe(body: unknown): void {
        const requestId = transcriptDropOf(body)?.requestId;
        if (!requestId) return;
        this.confirmedIds.add(requestId);
        const record = this.pending;
        if (record && record.requestId === requestId) {
            void this.apply(record, { kind: 'confirm' });
            return;
        }
        void this.reapplyIfReverted(requestId);
    }

    /**
     * The web hides the turns only AFTER it saw our record, but its tombstone
     * may still land after the deadline (slow outbox). The log then says
     * "rewound": follow it, or screen and agent disagree again. Synchronous up
     * to the abort, so the edited prompt that follows the tombstone is not
     * dequeued by the old query.
     */
    private reapplyIfReverted(requestId: string): Promise<void> {
        const reverted = this.lastReverted;
        if (this.pending || reverted?.requestId !== requestId || this.deps.currentClaudeSessionId() !== reverted.sourceClaudeSessionId) {
            return Promise.resolve();
        }
        this.lastReverted = null;
        this.deps.log(`[rewind] late tombstone for reverted ${requestId}; re-applying the rewind`);
        return this.deps.switchConversation(reverted.claudeSessionId)
            .then(() => this.deps.writeRecord({ ...reverted, state: 'confirmed' }))
            .catch((error) => this.deps.log('[rewind] re-applying failed', error));
    }

    /** Resolves when no rewind is pending (or `signal` aborts). */
    settled(signal?: AbortSignal): Promise<void> {
        if (!this.pending || signal?.aborted) return Promise.resolve();
        return new Promise((resolve) => {
            const done = () => {
                signal?.removeEventListener('abort', done);
                resolve();
            };
            this.waiters.push(done);
            signal?.addEventListener('abort', done, { once: true });
        });
    }

    check(): Promise<void> {
        if (!this.checking) {
            this.checking = this.runCheck().finally(() => { this.checking = null; });
        }
        return this.checking;
    }

    /** Wrapper start / resume: decide a leftover pending record, else repair a legacy split. */
    async startup(): Promise<void> {
        const record = parseRewindRecord(this.deps.readRecord());
        if (record?.state === 'pending') {
            this.pending = chainRewindRecord(record, this.pending);
            this.deps.log(`[rewind] startup: pending record ${record.requestId} from ${new Date(record.at).toISOString()}`);
            await this.check();
            return;
        }
        if (record?.state === 'reverted') {
            // Reverted by an earlier process; its tombstone may have landed since.
            this.lastReverted = record;
            if (tombstoneRequestIds(await this.deps.readLog()).has(record.requestId)) {
                await this.reapplyIfReverted(record.requestId);
                return;
            }
        }
        await this.repairLineage();
    }

    dispose(): void {
        this.disposed = true;
        this.clearTimer();
        this.release();
    }

    private arm(record: RewindRecord, ms?: number): void {
        if (this.disposed) return;
        if (this.timer) clearTimeout(this.timer);
        const wait = ms ?? Math.min(REWIND_POLL_MS, Math.max(0, decideWaitMs(record, this.deps.now())));
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.check().catch((error) => this.deps.log('[rewind] check failed', error));
        }, wait);
        this.timer.unref?.();
    }

    private async runCheck(): Promise<void> {
        const record = this.pending;
        if (!record) return;
        let decision = this.decide(record);
        if (decision.kind !== 'confirm' && decision.kind !== 'none') {
            // The durable log is the authority: never revert (or keep prompts
            // waiting) on the live stream alone.
            try {
                for (const id of tombstoneRequestIds(await this.deps.readLog())) this.confirmedIds.add(id);
            } catch (error) {
                this.deps.log('[rewind] reading the session log failed; retrying', error);
                if (this.pending === record) this.arm(record, REWIND_POLL_MS);
                return;
            }
            if (this.pending !== record) return;
            decision = this.decide(record);
        }
        await this.apply(record, decision);
    }

    private decide(record: RewindRecord): RewindDecision {
        return decideRewind(record, this.confirmedIds, this.deps.now(), this.deps.currentClaudeSessionId());
    }

    private async apply(record: RewindRecord, decision: RewindDecision): Promise<void> {
        if (this.pending !== record) return;
        switch (decision.kind) {
            case 'none':
                this.pending = null;
                this.release();
                return;
            case 'wait':
                this.arm(record);
                return;
            case 'confirm':
                this.finish(record, 'confirmed');
                return;
            case 'supersede':
                this.deps.log(`[rewind] ${record.requestId} unconfirmed but the agent already moved on; closing it`);
                this.finish(record, 'superseded');
                return;
            case 'revert': {
                this.deps.log(`[rewind] ${record.requestId} never confirmed by the log; switching back to ${decision.to}`);
                // Leave pending BEFORE switching: a tombstone that lands while
                // the query relaunches is then a late confirm (re-apply), not
                // a confirm the revert would silently overwrite. Waiters are
                // released only after the switch — the old query's prompt must
                // not be dequeued and then killed by the relaunch.
                this.pending = null;
                this.clearTimer();
                this.lastReverted = record;
                try {
                    await this.deps.switchConversation(decision.to);
                } catch (error) {
                    this.deps.log('[rewind] switching back failed; retrying', error);
                    if (!this.pending && this.lastReverted === record) {
                        this.lastReverted = null;
                        this.pending = record;
                        this.arm(record, REWIND_POLL_MS);
                    }
                    return;
                }
                // Re-applied by a late tombstone meanwhile: that wrote 'confirmed'.
                if (this.lastReverted === record) this.record(record, 'reverted');
                if (!this.pending) this.release();
                return;
            }
        }
    }

    private finish(record: RewindRecord, state: RewindRecord['state']): void {
        if (this.pending !== record) return;
        this.pending = null;
        this.clearTimer();
        this.lastReverted = null;
        this.record(record, state);
        this.release();
    }

    private record(record: RewindRecord, state: RewindRecord['state']): void {
        this.deps.log(`[rewind] ${record.requestId} ${state}`);
        void this.deps.writeRecord({ ...record, state }).catch((error) => this.deps.log('[rewind] recording state failed', error));
    }

    private clearTimer(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private release(): void {
        const waiters = this.waiters;
        this.waiters = [];
        for (const resolve of waiters) resolve();
    }

    private async repairLineage(): Promise<void> {
        const current = this.deps.currentClaudeSessionId();
        if (!current) return;
        const lines = await this.deps.readTranscript(current);
        if (!lines) return;
        const lineage = transcriptLineage(lines, current);
        if (!lineage.sourceClaudeSessionId) return;
        const sourceLines = await this.deps.readTranscript(lineage.sourceClaudeSessionId);
        if (!sourceLines) return;
        const source = transcriptLineage(sourceLines, lineage.sourceClaudeSessionId);
        const repair = decideLineageRepair({
            visibleLocalIds: visibleUserLocalIds(await this.deps.readLog()),
            current: lineage,
            source: { claudeSessionId: lineage.sourceClaudeSessionId, promptUuids: source.promptUuids },
        });
        if (repair.kind === 'none') return;
        // A rewind may have started while the log was being read.
        if (this.pending || this.deps.currentClaudeSessionId() !== current) return;
        this.deps.log(`[rewind] startup: ${current} is an unconfirmed rewound copy (${repair.missing.length} visible prompt(s) only in ${repair.to}); switching back`, {
            missing: repair.missing,
            forgottenAfterSplit: repair.onlyInCurrent,
        });
        await this.deps.switchConversation(repair.to);
    }
}

function decideWaitMs(record: RewindRecord, now: number): number {
    const decision = decideRewind(record, new Set(), now, record.claudeSessionId);
    return decision.kind === 'wait' ? decision.ms : 0;
}

type MetadataClient = {
    updateMetadata: (handler: (metadata: any) => any) => void;
    getMetadata: () => { rewind?: unknown } | null;
};

/**
 * Write `metadata.rewind` through the versioned metadata update and resolve
 * once the server's copy holds it (or after `timeoutMs`; the update keeps
 * retrying in the background). A state change never overwrites a NEWER
 * rewind's record.
 */
export async function persistRewindRecord(
    client: MetadataClient,
    record: RewindRecord,
    opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
    const owns = (raw: unknown) => {
        const existing = parseRewindRecord(raw);
        return record.state === 'pending' || !existing || existing.requestId === record.requestId;
    };
    if (!owns(client.getMetadata()?.rewind)) return;
    client.updateMetadata((metadata) => owns(metadata?.rewind) ? { ...metadata, rewind: record } : metadata);
    const deadline = Date.now() + (opts.timeoutMs ?? 8_000);
    while (Date.now() < deadline) {
        const current = parseRewindRecord(client.getMetadata()?.rewind);
        if (current?.requestId === record.requestId && current.state === record.state) return;
        await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 100));
    }
}
