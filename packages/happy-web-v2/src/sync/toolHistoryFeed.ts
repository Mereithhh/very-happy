import type { KvChange } from './kvUpdates';
import type { ToolHistoryEntry } from './toolHistory';

/** A scoped, disposable feed. KV versions fence GET/push/decryption races. */
export function createToolHistoryFeed(options: {
    key: string;
    read: (signal: AbortSignal) => Promise<{value: string | null; version: number}>;
    decode: (value: string | null) => Promise<ToolHistoryEntry[]>;
    onEntries: (entries: ToolHistoryEntry[]) => void;
    onError: (failed: boolean) => void;
}) {
    const controller = new AbortController();
    let version = -2;
    let sequence = 0;
    async function apply(item: {value: string | null; version: number}) {
        if (controller.signal.aborted || item.version < version) return;
        version = item.version;
        const request = ++sequence;
        try {
            const entries = await options.decode(item.value);
            if (!controller.signal.aborted && request === sequence) { options.onEntries(entries); options.onError(false); }
        } catch { if (!controller.signal.aborted && request === sequence) options.onError(true); }
    }
    return {
        async refresh() {
            const before = sequence;
            try {
                const item = await options.read(controller.signal);
                // KV GET hides deleted rows. Accept a 404 only if no newer
                // push/decode started since this read, keeping the version fence.
                if (item.version === -1) {
                    if (sequence === before) await apply({...item, version:Math.max(version, -1)});
                } else await apply(item);
            }
            catch { if (!controller.signal.aborted && sequence === before) options.onError(true); }
        },
        changes(changes: readonly KvChange[]) {
            for (const change of changes) if (change.key === options.key) void apply(change);
        },
        dispose() { controller.abort(); sequence++; },
    };
}
