import * as React from 'react';
import { Platform } from 'react-native';

/**
 * Unified Cmd+1..9 quick-switch map for the *active* sidebar list rendered by
 * ActiveSessionsGroupCompact (Claude sessions AND web terminals), numbered
 * 1..9 in the exact top-to-bottom order the user sees. So the hover badge on a
 * row and the ⌘<n> it jumps to always line up.
 *
 * This is a tiny module-level external store (same pattern as
 * useCommandKeyHeld): the list component publishes `byNumber` as it builds its
 * ordered groups, and the global key handler reads it. Rows don't subscribe to
 * the whole map — they're handed their own `quickNum` as a prop — so only the
 * handler consumes this store via the hook.
 */

export const QUICK_SWITCH_MAX = 9;

export type QuickSwitchTarget =
    | { kind: 'session'; sessionId: string }
    | { kind: 'terminal'; machineId: string; tid: string };

export type QuickSwitchByNumber = Record<number, QuickSwitchTarget>;

const EMPTY: QuickSwitchByNumber = {};

let byNumber: QuickSwitchByNumber = EMPTY;
const subscribers = new Set<() => void>();

function emit() {
    subscribers.forEach((fn) => fn());
}

// Shallow structural equality on the 1..9 entries so an identical recompute
// (e.g. an unrelated heartbeat) doesn't churn subscribers.
function equal(a: QuickSwitchByNumber, b: QuickSwitchByNumber): boolean {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
        const av = a[Number(k)];
        const bv = b[Number(k)];
        if (!bv || av.kind !== bv.kind) return false;
        if (av.kind === 'session' && bv.kind === 'session') {
            if (av.sessionId !== bv.sessionId) return false;
        } else if (av.kind === 'terminal' && bv.kind === 'terminal') {
            if (av.machineId !== bv.machineId || av.tid !== bv.tid) return false;
        } else {
            return false;
        }
    }
    return true;
}

/** Publish a freshly-built map. No-op (no emit) when structurally unchanged. */
export function setQuickSwitchMap(next: QuickSwitchByNumber) {
    if (equal(byNumber, next)) return;
    byNumber = Object.keys(next).length === 0 ? EMPTY : next;
    emit();
}

/** Synchronous read for the key handler (always fresh, no React subscription). */
export function getQuickSwitchTarget(n: number): QuickSwitchTarget | undefined {
    return byNumber[n];
}

function subscribe(fn: () => void): () => void {
    subscribers.add(fn);
    return () => {
        subscribers.delete(fn);
    };
}

function getSnapshot(): QuickSwitchByNumber {
    return byNumber;
}

function getServerSnapshot(): QuickSwitchByNumber {
    return EMPTY;
}

const noopSubscribe = () => () => {};

/** Subscribe to the unified quick-switch map. Always empty on native. */
export function useQuickSwitchMap(): QuickSwitchByNumber {
    return React.useSyncExternalStore(
        Platform.OS === 'web' ? subscribe : noopSubscribe,
        Platform.OS === 'web' ? getSnapshot : getServerSnapshot,
        getServerSnapshot,
    );
}
