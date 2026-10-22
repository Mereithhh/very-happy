/**
 * B-766 W-2 — the one 「需要你」 selector (DESIGN §4.4 step 1, §6.1).
 *
 * Merges the two persistent "waiting on you" sources: 汇报板 items that wait on
 * the owner (`needsOwner && active`, W0) and automation runs flagged
 * `needsAttention` and not yet acked (B-508). Counted per session with a Set,
 * so a session with three open decisions is one row that needs you — the same
 * rule as the board's urgent band in `sidebarAttention`.
 */
import { isAttentionActive, type AttentionItem } from '@slopus/happy-wire';
import { useEffect, useMemo } from 'react';
import { loadNeedsYouItems, useAttentionStore } from './attentionStore';
import { sync } from './sync';

export interface NeedsYou {
    /** Sessions with an open 汇报板 item that waits on the owner. */
    itemSessionIds: ReadonlySet<string>;
    /** Sessions a flagged automation run is about. */
    automationSessionIds: ReadonlySet<string>;
    /** Every session that needs you, either way. */
    sessionIds: ReadonlySet<string>;
    /** Open needs-owner items (inferred drafts included: they wait on you too). */
    items: number;
    automations: number;
}

export function needsYouOf(
    itemsBySession: Readonly<Record<string, readonly AttentionItem[]>>,
    automationSessionIds: ReadonlySet<string> = new Set(),
    automationCount = 0,
): NeedsYou {
    const itemSessionIds = new Set<string>();
    let items = 0;
    for (const [sessionId, list] of Object.entries(itemsBySession)) {
        for (const item of list) {
            if (!item.needsOwner || !isAttentionActive(item.state)) continue;
            items++;
            itemSessionIds.add(sessionId);
        }
    }
    return {
        itemSessionIds,
        automationSessionIds,
        sessionIds: new Set([...itemSessionIds, ...automationSessionIds]),
        items,
        automations: automationCount,
    };
}

/** Row keys that need the user: the board's urgent band plus sessions with an open 汇报板 item. */
export function withItemAttention(keys: ReadonlySet<string>, itemSessionIds: ReadonlySet<string>): Set<string> {
    const out = new Set(keys);
    for (const id of itemSessionIds) out.add(id);
    return out;
}

/** Sessions with an open needs-owner 汇报板 item (stable while the item set is unchanged). */
export function useItemNeedsYouSessionIds(): ReadonlySet<string> {
    const bySession = useAttentionStore((s) => (s.disabled ? null : s.bySession));
    return useMemo(() => (bySession ? needsYouOf(bySession).itemSessionIds : new Set<string>()), [bySession]);
}

/** Keep the account-wide needs-owner items loaded: on mount and on every web resume (AGENTS #13: via sync.onResume). */
export function useNeedsYouSync(enabled = true): void {
    useEffect(() => {
        if (!enabled) return;
        void loadNeedsYouItems();
        return sync.onResume(() => { void loadNeedsYouItems(); });
    }, [enabled]);
}
