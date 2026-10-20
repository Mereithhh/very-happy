/**
 * B-650 — source 2: fan the query out to every machine in scope at once.
 * Each machine answers (or fails) on its own; a machine still building its
 * index is re-asked every HISTORY_SEARCH_POLL_MS so results fill in. Offline
 * machines and daemons without `history-search` are never called — they are
 * reported so the panel can say the content results are incomplete.
 */
import { useEffect, useRef, useState } from 'react';
import type { Machine } from '@/sync/storageTypes';
import { machineHistorySearch } from '@/sync/ops';
import { machineLabel } from '@/utils/machineUtils';
import {
    HISTORY_SEARCH_DEBOUNCE_MS,
    HISTORY_SEARCH_POLL_MS,
    historySearchSupported,
    type HistorySearchHit,
} from '@/screens/sessions/historySearch';
import { CONTENT_RESULT_LIMIT, MACHINE_SEARCH_TIMEOUT_MS, type MachineCoverage } from './sessionSearch';

export interface ContentSearchState {
    hits: ReadonlyMap<string, HistorySearchHit[]>;
    coverage: MachineCoverage[];
}

const EMPTY: ContentSearchState = { hits: new Map(), coverage: [] };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve('timeout'), ms);
        p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve('timeout'); });
    });
}

export function useContentSearch(opts: {
    /** '' = no content search (empty query, or an agent the index does not cover). */
    query: string;
    agent?: 'claude' | 'codex';
    machines: readonly Machine[];
}): ContentSearchState {
    const { query, agent, machines } = opts;
    const [state, setState] = useState<ContentSearchState>(EMPTY);
    const [pollTick, setPollTick] = useState(0);
    const round = useRef(0);
    const lastKey = useRef('');
    // Machine identity / reachability, not the whole record (daemonState churns).
    const scopeKey = machines.map((m) => `${m.id}:${m.active ? 1 : 0}:${historySearchSupported(m.daemonState) ? 1 : 0}`).join(',');
    const machinesRef = useRef(machines);
    machinesRef.current = machines;

    useEffect(() => {
        const mine = ++round.current;
        const list = machinesRef.current;
        if (!query) { setState(EMPTY); lastKey.current = ''; return; }
        const key = `${query}\n${agent ?? ''}\n${scopeKey}`;
        const isPoll = key === lastKey.current;
        const initial: MachineCoverage[] = list.map((m) => ({
            machineId: m.id,
            name: machineLabel(m),
            state: !m.active ? 'offline' : !historySearchSupported(m.daemonState) ? 'unsupported' : 'pending',
        }));
        if (!isPoll) setState({ hits: new Map(), coverage: initial });
        const timer = setTimeout(() => {
            lastKey.current = key;
            const callable = initial.filter((c) => c.state === 'pending');
            for (const c of callable) {
                void withTimeout(
                    machineHistorySearch(c.machineId, { query, limit: CONTENT_RESULT_LIMIT, ...(agent ? { agent } : {}) }, { timeoutMs: MACHINE_SEARCH_TIMEOUT_MS }),
                    MACHINE_SEARCH_TIMEOUT_MS + 500,
                ).then((res) => {
                    if (mine !== round.current) return;
                    setState((prev) => {
                        const hits = new Map(prev.hits);
                        const coverage = prev.coverage.map((x) => {
                            if (x.machineId !== c.machineId) return x;
                            if (res === 'timeout' || !res.ok) return { ...x, state: 'failed' as const };
                            const indexing = res.status.state === 'indexing';
                            return {
                                ...x,
                                state: indexing ? 'indexing' as const : 'searched' as const,
                                ...(indexing ? { progress: { done: res.status.filesDone, total: res.status.filesTotal } } : {}),
                            };
                        });
                        if (res !== 'timeout' && res.ok) hits.set(c.machineId, res.hits);
                        return { hits, coverage };
                    });
                });
            }
        }, isPoll ? 0 : HISTORY_SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query, agent, scopeKey, pollTick]);

    const indexing = state.coverage.some((c) => c.state === 'indexing');
    useEffect(() => {
        if (!query || !indexing) return;
        const t = setTimeout(() => setPollTick((n) => n + 1), HISTORY_SEARCH_POLL_MS);
        return () => clearTimeout(t);
    }, [query, indexing, state]);

    return state;
}
