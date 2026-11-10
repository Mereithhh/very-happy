/**
 * B-918: "the same preview jumps once" — within this tab and across tabs.
 *
 * The relay fans a push out to every web client of the account, so several
 * tabs of one browser receive it together. Only a VISIBLE tab may jump; a
 * hidden one parks the push and replays it when it becomes visible, unless a
 * sibling tab already jumped for it (announced over BroadcastChannel).
 */
import type { FsPreviewRequest } from '@/sync/filePreviewOpen';

/** A repeat of the same push inside this window is the same preview. */
export const JUMP_DEDUPE_MS = 15_000;
/** A parked push older than this when the tab comes back is stale: drop it. */
export const HIDDEN_PARK_MAX_MS = 5 * 60_000;

export function previewKey(request: FsPreviewRequest): string {
    return [request.sessionId ?? '', request.machineId, request.path, request.mode, request.intent ?? ''].join('\n');
}

/** Pure ledger of jumps seen (here or announced by another tab). */
export class JumpLedger {
    private readonly at = new Map<string, number>();
    mark(key: string, now: number): void {
        this.at.set(key, now);
        for (const [k, t] of this.at) if (now - t > JUMP_DEDUPE_MS) this.at.delete(k);
    }
    /** Jumped for `key` at or after `since` (and within the dedupe window). */
    seen(key: string, now: number, since = now - JUMP_DEDUPE_MS): boolean {
        const t = this.at.get(key);
        return t !== undefined && t >= since && now - t <= JUMP_DEDUPE_MS;
    }
}

const CHANNEL = 'vh-preview-jump';
const ledger = new JumpLedger();
let channel: BroadcastChannel | null | undefined;

function getChannel(): BroadcastChannel | null {
    if (channel !== undefined) return channel;
    try {
        channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
        channel?.addEventListener('message', (e: MessageEvent) => {
            if (typeof e.data?.key === 'string') ledger.mark(e.data.key, Date.now());
        });
    } catch {
        channel = null;
    }
    return channel;
}

/** Start listening for sibling tabs' jumps (call once on mount). */
export function listenForJumps(): void { getChannel(); }

/** Whether this preview already jumped (here, or in another tab since it arrived). */
export function alreadyJumped(key: string, arrivedAt: number): boolean {
    return ledger.seen(key, Date.now(), arrivedAt - 1000);
}

/** Record a jump and tell sibling tabs. */
export function recordJump(key: string): void {
    ledger.mark(key, Date.now());
    try { getChannel()?.postMessage({ key }); } catch { /* best effort */ }
}
