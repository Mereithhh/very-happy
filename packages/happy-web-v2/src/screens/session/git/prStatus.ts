/**
 * B-584: `gh pr view --json …` → PR state + CI rollup summary. Pure.
 *
 * Conclusion mapping follows Orca's `main/github/mappers.ts` (STALE and
 * STARTUP_FAILURE are failures, ACTION_REQUIRED needs attention). Unknown
 * enum values are NOT counted as pending, so a value GitHub adds later can't
 * leave the chip spinning forever.
 */
import { safeHttpsUrl } from './gitRemote';

export type PrState = 'open' | 'draft' | 'merged' | 'closed';
export type CheckCounts = { passed: number; failed: number; pending: number; total: number };
export type FailedCheck = { name: string; url: string | null; runId: string | null };
export type PrInfo = { number: number; state: PrState; url: string | null; title: string; checks: CheckCounts; failed: FailedCheck[] };
export type CiOverall = 'none' | 'passed' | 'failed' | 'pending';

export type PrLookup =
    | { kind: 'pr'; pr: PrInfo }
    /** gh works, the branch just has no PR */
    | { kind: 'none' }
    /** no gh / not logged in / not GitHub / offline — render nothing */
    | { kind: 'unavailable' };

const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAIL = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'STALE', 'ERROR']);
const PENDING_STATE = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);

type Verdict = 'passed' | 'failed' | 'pending' | null;

function verdictOf(item: Record<string, unknown>): Verdict {
    const up = (v: unknown) => (typeof v === 'string' ? v.toUpperCase() : '');
    if (item.__typename === 'StatusContext' || ('context' in item && 'state' in item)) {
        const s = up(item.state);
        if (s === 'SUCCESS') return 'passed';
        if (s === 'FAILURE' || s === 'ERROR') return 'failed';
        if (PENDING_STATE.has(s)) return 'pending';
        return null;
    }
    const status = up(item.status);
    if (status && status !== 'COMPLETED') return PENDING_STATE.has(status) ? 'pending' : null;
    const conclusion = up(item.conclusion);
    if (PASS.has(conclusion)) return 'passed';
    if (FAIL.has(conclusion)) return 'failed';
    return null;
}

export function runIdFromUrl(url: string | null): string | null {
    if (!url) return null;
    const m = /\/actions\/runs\/(\d+)/.exec(url);
    return m ? m[1] : null;
}

export function summarizeRollup(rollup: unknown): { checks: CheckCounts; failed: FailedCheck[] } {
    const checks: CheckCounts = { passed: 0, failed: 0, pending: 0, total: 0 };
    const failed: FailedCheck[] = [];
    if (!Array.isArray(rollup)) return { checks, failed };
    for (const raw of rollup) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        const verdict = verdictOf(item);
        if (!verdict) continue;
        checks.total++;
        checks[verdict]++;
        if (verdict === 'failed') {
            const name = String(item.name ?? item.context ?? '').trim() || '(unnamed)';
            const url = safeHttpsUrl(item.detailsUrl ?? item.targetUrl);
            failed.push({ name, url, runId: runIdFromUrl(url) });
        }
    }
    return { checks, failed };
}

export function ciOverall(checks: CheckCounts): CiOverall {
    if (checks.failed > 0) return 'failed';
    if (checks.pending > 0) return 'pending';
    if (checks.passed > 0) return 'passed';
    return 'none';
}

function prState(state: unknown, isDraft: unknown): PrState | null {
    const s = typeof state === 'string' ? state.toUpperCase() : '';
    if (s === 'MERGED') return 'merged';
    if (s === 'CLOSED') return 'closed';
    if (s === 'OPEN') return isDraft === true ? 'draft' : 'open';
    return null;
}

export function parsePrView(stdout: string): PrInfo | null {
    let data: unknown;
    try {
        data = JSON.parse(stdout);
    } catch {
        return null;
    }
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    const number = typeof d.number === 'number' && Number.isInteger(d.number) && d.number > 0 ? d.number : null;
    const state = prState(d.state, d.isDraft);
    if (number === null || !state) return null;
    const { checks, failed } = summarizeRollup(d.statusCheckRollup);
    return { number, state, url: safeHttpsUrl(d.url), title: typeof d.title === 'string' ? d.title : '', checks, failed };
}

export function classifyPrView(res: { success?: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string }): PrLookup {
    if (res.success && res.exitCode === 0) {
        const pr = parsePrView(res.stdout ?? '');
        return pr ? { kind: 'pr', pr } : { kind: 'unavailable' };
    }
    const text = `${res.stderr ?? ''}\n${res.stdout ?? ''}`;
    if (/no pull requests? found/i.test(text)) return { kind: 'none' };
    return { kind: 'unavailable' };
}

export const PR_POLL_MS = 60_000;
export const PR_UNAVAILABLE_POLL_MS = 10 * 60_000;

/** Keep the last PR through a transient failure instead of flickering away. */
export function mergeLookup(prev: PrLookup | undefined, next: PrLookup): PrLookup {
    if (next.kind === 'unavailable' && prev?.kind === 'pr') return prev;
    return next;
}

/** Next poll delay for the current state: no gh / not GitHub backs off. */
export function pollDelayFor(lookup: PrLookup | null): number {
    return lookup?.kind === 'unavailable' ? PR_UNAVAILABLE_POLL_MS : PR_POLL_MS;
}
