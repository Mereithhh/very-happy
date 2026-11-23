import { CODEX_CONTEXT_MAX_CHILDREN, codexContextOccupancy, type CodexContextUsage } from '@slopus/happy-wire';

type Occupancy = { tokens: number | null; contextWindow?: number | null };

/**
 * B-963: the context occupancy of the session's thread and its sub-agent
 * threads, mirrored into agentState. Codex notifies after every request, and
 * agentState is a versioned write, so writes are spaced by `minIntervalMs`;
 * the newest value is always written in the end.
 */
export class CodexContextTracker {
    private main: ({ threadId: string } & Occupancy) | null = null;
    /** Insertion order = oldest first. */
    private children = new Map<string, Occupancy>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private lastWriteAt = 0;

    constructor(
        private readonly write: (usage: CodexContextUsage | null) => void,
        private readonly minIntervalMs = 2_000,
        private readonly now: () => number = Date.now,
        /** What a previous wrapper of this session left in agentState: a resume replays the thread's own figure only. */
        private readonly persisted: () => CodexContextUsage | null = () => null,
    ) {}

    /** A `token_count` / `child_token_count` event. */
    onUsage(event: { type: string; thread_id?: unknown } & Record<string, unknown>): void {
        const threadId = typeof event.thread_id === 'string' ? event.thread_id : null;
        const occupancy = codexContextOccupancy(event);
        if (!threadId || !occupancy) return;
        if (!this.main && this.children.size === 0) this.adopt(event.type === 'child_token_count' ? null : threadId);
        if (event.type === 'child_token_count') {
            this.children.delete(threadId);
            this.children.set(threadId, occupancy);
            while (this.children.size > CODEX_CONTEXT_MAX_CHILDREN) {
                const oldest = this.children.keys().next().value;
                if (oldest === undefined) break;
                this.children.delete(oldest);
            }
            if (!this.main) return; // written with the session thread's first figure
        } else {
            if (this.main && this.main.threadId !== threadId) this.children.clear();
            this.main = { threadId, ...occupancy };
        }
        this.schedule();
    }

    private adopt(threadId: string | null): void {
        const left = this.persisted();
        if (!left || (threadId !== null && left.threadId !== threadId)) return;
        for (const child of [...(left.children ?? [])].reverse()) this.children.set(child.threadId, { tokens: child.tokens, contextWindow: child.contextWindow });
    }

    /** History was rewound: Codex reports nothing until the next request, the old figure is wrong. */
    invalidate(): void {
        if (!this.main) return;
        this.main = { ...this.main, tokens: null };
        this.flush();
    }

    /** The thread is gone (`/clear`). */
    reset(): void {
        this.main = null;
        this.children.clear();
        this.flush();
    }

    /** Write the pending value now (session is ending). */
    dispose(): void {
        if (this.timer) this.flush();
    }

    private schedule(): void {
        if (this.timer) return;
        const wait = this.lastWriteAt + this.minIntervalMs - this.now();
        if (wait <= 0) return this.flush();
        this.timer = setTimeout(() => this.flush(), wait);
        this.timer.unref?.();
    }

    private flush(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.lastWriteAt = this.now();
        this.write(this.main && {
            ...this.main,
            updatedAt: this.lastWriteAt,
            ...(this.children.size > 0 ? { children: [...this.children].reverse().map(([threadId, o]) => ({ threadId, ...o })) } : {}),
        });
    }
}
