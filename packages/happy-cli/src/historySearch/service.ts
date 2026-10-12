/**
 * B-549 — the daemon-side history search service behind the `history-search`
 * machine RPC.
 *
 * Lifecycle:
 * - Nothing happens until the first search: a daemon whose user never
 *   searches never reads a transcript.
 * - A search loads the persisted index (bounded wait), starts an incremental
 *   refresh in the background when the last one is older than
 *   `refreshIntervalMs`, and answers IMMEDIATELY from what is indexed so far,
 *   with the progress. The web polls while `state === 'indexing'` — a cold
 *   build over gigabytes of transcripts must never hold an RPC near the 30 s
 *   relay limit (iron rule 17).
 * - The in-memory index is dropped after `idleUnloadMs` without searches; the
 *   file under `<HAPPY_HOME>/history-search/` stays.
 * - `clear` cancels a running pass and deletes the directory.
 *
 * Privacy: the index is conversation text from this machine and stays on this
 * machine. Logs carry only lengths and counts, never the query or snippets.
 */
import { logger } from '@/ui/logger';
import { refreshRecords, type HistoryRoots } from './indexer';
import { parseQuery, searchRecords, DEFAULT_RESULTS, type SearchResult } from './query';
import { clearIndexDir, DEFAULT_MAX_TEXT_CHARS, loadIndex, saveIndex, totalChars, type FileRecord } from './store';
import type { HistorySearchAgent } from './extract';

export type HistorySearchState = 'idle' | 'indexing' | 'ready' | 'error';

export type HistorySearchStatus = {
    state: HistorySearchState;
    filesTotal: number;
    filesDone: number;
    sessions: number;
    textChars: number;
    maxTextChars: number;
    evicted: number;
    lastIndexedAt?: number;
    error?: string;
};

export type HistorySearchResponse = {
    type: 'success';
    status: HistorySearchStatus;
    results: SearchResult[];
    truncated: boolean;
};

export type HistorySearchServiceOptions = {
    indexDir: string;
    resolveRoots: () => Promise<HistoryRoots>;
    maxTextChars?: number;
    refreshIntervalMs?: number;
    idleUnloadMs?: number;
    loadWaitMs?: number;
    now?: () => number;
};

export class HistorySearchService {
    private records: Map<string, FileRecord> | null = null;
    private loading: Promise<void> | null = null;
    private refreshing: Promise<void> | null = null;
    private progress = { filesTotal: 0, filesDone: 0 };
    private lastRefreshStartedAt = 0;
    private lastIndexedAt: number | undefined;
    private error: string | undefined;
    /** Bumped by `clear`; a pass started under an older generation stops. */
    private generation = 0;
    /** A `clear` in progress. Searches arriving meanwhile neither load the
     *  old file back nor start a pass that would recreate the directory. */
    private clearing: Promise<void> | null = null;
    private idleTimer: NodeJS.Timeout | null = null;
    private readonly opts: Required<Omit<HistorySearchServiceOptions, 'indexDir' | 'resolveRoots'>> & Pick<HistorySearchServiceOptions, 'indexDir' | 'resolveRoots'>;

    constructor(options: HistorySearchServiceOptions) {
        this.opts = {
            maxTextChars: DEFAULT_MAX_TEXT_CHARS,
            refreshIntervalMs: 30_000,
            idleUnloadMs: 10 * 60_000,
            loadWaitMs: 5_000,
            now: Date.now,
            ...options,
        };
    }

    /** RPC entry point. Validates loosely; unknown fields are ignored. */
    async handle(params: unknown): Promise<HistorySearchResponse> {
        const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
        const op = p.op === 'status' || p.op === 'clear' ? p.op : 'search';
        if (op === 'clear') {
            await this.clear();
            return { type: 'success', status: this.status(), results: [], truncated: false };
        }
        if (op === 'status') {
            return { type: 'success', status: this.status(), results: [], truncated: false };
        }
        const agent: HistorySearchAgent | undefined = p.agent === 'claude' || p.agent === 'codex' ? p.agent : undefined;
        const limit = typeof p.limit === 'number' && Number.isFinite(p.limit) ? p.limit : DEFAULT_RESULTS;
        return this.search(p.query, { agent, limit });
    }

    async search(query: unknown, options: { agent?: HistorySearchAgent; limit?: number } = {}): Promise<HistorySearchResponse> {
        if (this.clearing) {
            // Asked while the index is being deleted (a poll that was already
            // in flight): answer "nothing indexed" and do not rebuild. The next
            // search after the clear finished rebuilds, as the user expects.
            await this.clearing;
            return { type: 'success', status: this.status(), results: [], truncated: false };
        }
        this.touch();
        await this.ensureLoaded();
        this.maybeRefresh();
        const parsed = parseQuery(query);
        if (!parsed || !this.records) {
            return { type: 'success', status: this.status(), results: [], truncated: false };
        }
        const started = this.opts.now();
        const out = searchRecords(this.records.values(), parsed, options);
        logger.debug(`[HISTORY SEARCH] query len=${parsed.raw.length} terms=${parsed.terms.length} → ${out.total} sessions (${this.opts.now() - started}ms)`);
        return { type: 'success', status: this.status(), results: out.results, truncated: out.truncated };
    }

    status(): HistorySearchStatus {
        const records = this.records;
        let sessions = 0;
        let evicted = 0;
        if (records) {
            for (const r of records.values()) {
                if (r.meta.skip) continue;
                sessions += 1;
                if (r.evicted) evicted += 1;
            }
        }
        const state: HistorySearchState = this.refreshing || this.loading
            ? 'indexing'
            : this.error ? 'error'
                : this.lastIndexedAt !== undefined ? 'ready' : 'idle';
        return {
            state,
            filesTotal: this.progress.filesTotal,
            filesDone: this.progress.filesDone,
            sessions,
            textChars: records ? totalChars(records.values()) : 0,
            maxTextChars: this.opts.maxTextChars,
            evicted,
            ...(this.lastIndexedAt !== undefined ? { lastIndexedAt: this.lastIndexedAt } : {}),
            ...(this.error ? { error: this.error } : {}),
        };
    }

    async clear(): Promise<void> {
        if (this.clearing) return this.clearing;
        const run = this.doClear().finally(() => { if (this.clearing === run) this.clearing = null; });
        this.clearing = run;
        return run;
    }

    private async doClear(): Promise<void> {
        // Let a running pass reach its next cancellation point first, so a
        // checkpoint save cannot land after the directory is gone.
        const running = this.refreshing;
        this.generation += 1;
        this.records = null;
        this.loading = null;
        this.refreshing = null;
        this.progress = { filesTotal: 0, filesDone: 0 };
        this.lastRefreshStartedAt = 0;
        this.lastIndexedAt = undefined;
        this.error = undefined;
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        await running?.catch(() => undefined);
        await clearIndexDir(this.opts.indexDir);
        logger.debug('[HISTORY SEARCH] index cleared');
    }

    /** Resolves when the running refresh (if any) is done — tests and scripts. */
    async whenIdle(): Promise<void> {
        while (this.loading || this.refreshing) {
            await (this.loading ?? this.refreshing);
        }
    }

    private touch(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.unload(), this.opts.idleUnloadMs);
        this.idleTimer.unref?.();
    }

    private unload(): void {
        this.idleTimer = null;
        if (this.refreshing || this.loading) { this.touch(); return; }
        this.records = null;
        logger.debug('[HISTORY SEARCH] in-memory index unloaded (idle)');
    }

    private async ensureLoaded(): Promise<void> {
        if (this.clearing) await this.clearing;
        if (this.records) return;
        if (!this.loading) {
            const gen = this.generation;
            const run = (async () => {
                const loaded = await loadIndex(this.opts.indexDir);
                if (gen !== this.generation) return;
                this.records = loaded?.records ?? new Map();
                if (loaded && this.lastIndexedAt === undefined) this.lastIndexedAt = loaded.savedAt;
            })().catch((error) => {
                if (gen !== this.generation) return;
                logger.debug('[HISTORY SEARCH] index load failed; starting empty', error);
                this.records = new Map();
            }).finally(() => {
                if (this.loading === run) this.loading = null;
            });
            this.loading = run;
        }
        const pending = this.loading;
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
            pending,
            new Promise<void>((resolve) => { timer = setTimeout(resolve, this.opts.loadWaitMs); timer.unref?.(); }),
        ]);
        if (timer) clearTimeout(timer);
    }

    private maybeRefresh(): void {
        if (this.clearing || this.refreshing || !this.records) return;
        const now = this.opts.now();
        if (this.lastRefreshStartedAt && now - this.lastRefreshStartedAt < this.opts.refreshIntervalMs) return;
        this.lastRefreshStartedAt = now;
        const gen = this.generation;
        const records = this.records;
        // A pass from before a clear must never write: the generation check is
        // the last gate before the file is (re)created.
        const save = async () => {
            if (gen !== this.generation || this.clearing) return;
            await saveIndex(this.opts.indexDir, records.values(), this.opts.now());
        };
        const run = (async () => {
            const roots = await this.opts.resolveRoots();
            if (gen !== this.generation) return;
            const started = this.opts.now();
            const result = await refreshRecords(records, {
                roots,
                maxTextChars: this.opts.maxTextChars,
                isCancelled: () => gen !== this.generation,
                onProgress: (progress) => { if (gen === this.generation) this.progress = progress; },
                checkpoint: async () => { if (gen === this.generation) await save(); },
                now: this.opts.now,
            });
            if (result.cancelled || gen !== this.generation) return;
            if (result.changed) await save();
            this.lastIndexedAt = this.opts.now();
            this.error = undefined;
            logger.debug(`[HISTORY SEARCH] refresh: ${result.filesTotal} files, changed=${result.changed}, evicted=${result.evicted} (${this.opts.now() - started}ms)`);
        })().catch((error) => {
            if (gen !== this.generation) return;
            this.error = error instanceof Error ? error.message : String(error);
            logger.debug('[HISTORY SEARCH] refresh failed', error);
        }).finally(() => {
            if (this.refreshing === run) this.refreshing = null;
        });
        this.refreshing = run;
    }
}
