/**
 * todosModel — pure view logic for the external-todo panel (B-007).
 *
 * Everything here is a total function over plain data: no React, no RPC, no
 * clock. The screen is then a thin renderer, which is the only way ordering /
 * grouping / the optimistic-completion state machine stay testable while
 * several agents edit the screen in parallel.
 *
 * Contract notes that shape this module:
 *  - Items come from a user-configured provider on ANOTHER machine. Fields are
 *    optional and may be garbage; every helper degrades instead of throwing.
 *  - `complete` results are NOT parsed (spec D1). The optimistic flip therefore
 *    has no "confirmed" terminal state — it is cleared wholesale by the
 *    authoritative re-list (`refreshed`), never by the RPC's own answer.
 */
import type { TodoItem, TodoPriority, TodoStatus } from '@/sync/todoOps';

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

/** Sort weight for a priority (missing / unknown sorts with 'none'). */
export function priorityRank(priority: TodoPriority | undefined): number {
    switch (priority) {
        case 'high':
            return 0;
        case 'medium':
            return 1;
        case 'low':
            return 2;
        default:
            return 3;
    }
}

function statusRank(status: TodoStatus | undefined): number {
    return status === 'done' ? 1 : 0;
}

/** Non-empty `due` string, or null. Compared lexically — `due` is opaque to us
 *  (the contract says "passed through for display"), so ISO dates sort right
 *  and anything else at least sorts stably. */
function dueKey(item: TodoItem): string | null {
    const due = typeof item.due === 'string' ? item.due.trim() : '';
    return due === '' ? null : due;
}

/**
 * Open before done, then high→low priority, then earliest due (no due last),
 * then the provider's own order. Stable: equal items keep provider order, so a
 * provider that already sorts sensibly is not reshuffled.
 */
export function sortTodoItems(items: readonly TodoItem[]): TodoItem[] {
    return items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
            const byStatus = statusRank(a.item.status) - statusRank(b.item.status);
            if (byStatus !== 0) return byStatus;
            const byPriority = priorityRank(a.item.priority) - priorityRank(b.item.priority);
            if (byPriority !== 0) return byPriority;
            const da = dueKey(a.item);
            const db = dueKey(b.item);
            if (da !== db) {
                if (da === null) return 1;
                if (db === null) return -1;
                return da < db ? -1 : 1;
            }
            return a.index - b.index;
        })
        .map((x) => x.item);
}

// ---------------------------------------------------------------------------
// grouping
// ---------------------------------------------------------------------------

export interface TodoGroup {
    /** Provider-supplied group name, or null for the ungrouped bucket. */
    key: string | null;
    items: TodoItem[];
}

function groupKey(item: TodoItem): string | null {
    const group = typeof item.group === 'string' ? item.group.trim() : '';
    return group === '' ? null : group;
}

/**
 * Sort, then bucket by `group`. Named groups keep first-appearance order (of
 * the SORTED list, so the group with the most urgent item leads); the ungrouped
 * bucket always goes last. Items with no group at all → exactly one bucket with
 * `key: null`, which the screen renders headerless.
 */
export function groupTodoItems(items: readonly TodoItem[]): TodoGroup[] {
    const sorted = sortTodoItems(items);
    const named = new Map<string, TodoItem[]>();
    const ungrouped: TodoItem[] = [];
    for (const item of sorted) {
        const key = groupKey(item);
        if (key === null) {
            ungrouped.push(item);
            continue;
        }
        const bucket = named.get(key);
        if (bucket) bucket.push(item);
        else named.set(key, [item]);
    }
    const groups: TodoGroup[] = [...named.entries()].map(([key, groupItems]) => ({ key, items: groupItems }));
    if (ungrouped.length > 0 || groups.length === 0) groups.push({ key: null, items: ungrouped });
    return groups;
}

/** True when the provider supplied no groups at all → render a flat list. */
export function isFlat(groups: readonly TodoGroup[]): boolean {
    return groups.length === 1 && groups[0].key === null;
}

// ---------------------------------------------------------------------------
// optimistic completion (state machine)
// ---------------------------------------------------------------------------

export interface CompletionState {
    /** Ids flipped to done locally, awaiting the authoritative re-list. */
    readonly pending: readonly string[];
}

export const emptyCompletion: CompletionState = { pending: [] };

export type CompletionAction =
    /** user ticked the box — grey it out now */
    | { type: 'begin'; id: string }
    /** the complete RPC failed — put it back */
    | { type: 'rollback'; id: string }
    /** a fresh list arrived: the provider is the truth, drop every guess */
    | { type: 'refreshed' };

export function completionReducer(state: CompletionState, action: CompletionAction): CompletionState {
    switch (action.type) {
        case 'begin':
            if (state.pending.includes(action.id)) return state;
            return { pending: [...state.pending, action.id] };
        case 'rollback': {
            if (!state.pending.includes(action.id)) return state;
            return { pending: state.pending.filter((id) => id !== action.id) };
        }
        case 'refreshed':
            return state.pending.length === 0 ? state : emptyCompletion;
        default:
            return state;
    }
}

export function isCompleting(state: CompletionState, id: string): boolean {
    return state.pending.includes(id);
}

/**
 * What the row should LOOK like. Note it deliberately does not feed
 * `sortTodoItems`: an optimistic tick must not make the row jump away under the
 * finger — the re-list reorders it a moment later.
 */
export function displayStatus(item: TodoItem, state: CompletionState): TodoStatus {
    if (item.status === 'done') return 'done';
    return isCompleting(state, item.id) ? 'done' : 'open';
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

/** Whether the "some items are not shown" hint belongs on screen. */
export function hasOmissions(dropped: number, truncated: boolean): boolean {
    return truncated || (Number.isFinite(dropped) && dropped > 0);
}

/** Trim a composer draft into a title, or null when there is nothing to create. */
export function normalizeNewTitle(raw: string): string | null {
    const title = raw.replace(/\s+/g, ' ').trim();
    return title === '' ? null : title;
}

/**
 * Which machine the panel should read from: the remembered one while it still
 * exists, else the first online machine, else the first machine at all. The
 * provider is configured PER MACHINE (spec risk 5), so this choice is always
 * shown in the header — never implied.
 */
export function pickTodoMachine<T extends { id: string; active: boolean }>(
    machines: readonly T[],
    stored: string | null | undefined,
): string | null {
    if (machines.length === 0) return null;
    if (stored && machines.some((m) => m.id === stored)) return stored;
    return machines.find((m) => m.active)?.id ?? machines[0].id;
}
