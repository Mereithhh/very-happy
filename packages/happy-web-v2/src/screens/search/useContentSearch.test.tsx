// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine } from '@/sync/storageTypes';
import { setContentSearchOverride, useContentSearch, type ContentSearchState } from './useContentSearch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_700_000_000_000;
const machine = (id: string, active: boolean): Machine => ({
    id, active, metadata: { host: id }, daemonState: { startedAt: 1, historySearch: { rpcAvailable: true, detectedAt: 2 } },
} as unknown as Machine);
const hitFor = (query: string) => ({
    status: { state: 'ready' },
    results: [{ agent: 'claude', id: `0000000${query.length}-0000-4000-8000-000000000000`, title: query, updatedAt: NOW, cwd: '/r', matchCount: 1, snippets: [{ role: 'user', text: query, ranges: [[0, 1]] }] }],
});

let host: HTMLDivElement, root: Root;
let last: ContentSearchState | null = null;
function Probe({ query, machines }: { query: string; machines: Machine[] }) {
    last = useContentSearch({ query, machines, debounceMs: 50 });
    return null;
}
beforeEach(() => { vi.useFakeTimers(); host = document.createElement('div'); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); setContentSearchOverride(null); vi.useRealTimers(); last = null; });

describe('B-865 content search: debounce, stale answers, offline machines', () => {
    it('debounces keystrokes into one call per machine and drops a slow answer to an older query', async () => {
        const { parseHistorySearch } = await import('@/screens/sessions/historySearch');
        const resolvers: Array<{ query: string; resolve: () => void }> = [];
        const calls: string[] = [];
        setContentSearchOverride(((machineId: string, params: { query?: string }) => {
            calls.push(`${machineId}:${params.query}`);
            return new Promise((resolve) => {
                resolvers.push({ query: params.query!, resolve: () => resolve({ ok: true, ...parseHistorySearch(hitFor(params.query!)) }) });
            });
        }) as never);
        const machines = [machine('on', true), machine('off', false)];
        act(() => root.render(<Probe query="lo" machines={machines} />));
        act(() => { vi.advanceTimersByTime(20); });
        act(() => root.render(<Probe query="log" machines={machines} />));
        act(() => { vi.advanceTimersByTime(60); });
        expect(calls).toEqual(['on:log']); // "lo" never left the debounce; the offline machine is never called
        act(() => root.render(<Probe query="login" machines={machines} />));
        act(() => { vi.advanceTimersByTime(60); });
        expect(calls).toEqual(['on:log', 'on:login']);
        // the newer answer lands first, then the stale one
        await act(async () => { resolvers[1].resolve(); await Promise.resolve(); await Promise.resolve(); });
        await act(async () => { resolvers[0].resolve(); await Promise.resolve(); await Promise.resolve(); });
        expect(last!.hits.get('on')?.map((h) => h.title)).toEqual(['login']);
        expect(last!.coverage.find((c) => c.machineId === 'off')?.state).toBe('offline');
        expect(last!.coverage.find((c) => c.machineId === 'on')?.state).toBe('searched');
    });
});
